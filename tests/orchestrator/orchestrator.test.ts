import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatePair, FlexibleSearchRequest } from "../../src/domain/types.js";
import { JsonJobStore } from "../../src/jobs/store.js";
import type { SearchJob } from "../../src/jobs/types.js";
import type { ProviderSearchInput, Quote } from "../../src/providers/types.js";
import { createSearchOrchestrator } from "../../src/orchestrator/index.js";
import { eventually } from "../helpers/eventually.js";
import {
  ControllableProvider,
  ImmediateProvider,
} from "../helpers/mock-provider.js";

const threePairs: DatePair[] = [
  { departureDate: "2026-10-01", returnDate: "2026-10-05", tripDays: 5 },
  { departureDate: "2026-10-02", returnDate: "2026-10-06", tripDays: 5 },
  { departureDate: "2026-10-03", returnDate: "2026-10-07", tripDays: 5 },
];

const request: FlexibleSearchRequest = {
  origin: "ICN",
  destination: "NRT",
  months: ["2026-10"],
  minTripDays: 5,
  maxTripDays: 5,
  departureWeekdays: [],
  returnWeekdays: [],
};

function makePairs(count: number, startDay = 1): DatePair[] {
  return Array.from({ length: count }, (_, index) => {
    const departure = new Date(Date.UTC(2026, 9, startDay + index));
    const returnDate = new Date(Date.UTC(2026, 9, startDay + index + 4));
    return {
      departureDate: departure.toISOString().slice(0, 10),
      returnDate: returnDate.toISOString().slice(0, 10),
      tripDays: 5,
    };
  });
}

class StatusObservingProvider extends ControllableProvider {
  constructor(
    id: "google" | "naver",
    private readonly observe: () => Promise<string>,
  ) {
    super(id);
  }

  override async findDirectRoundTrip(input: ProviderSearchInput): Promise<Quote> {
    this.observedStatuses.push(await this.observe());
    return super.findDirectRoundTrip(input);
  }

  readonly observedStatuses: string[] = [];
}

class FailOnceOnProgressStore extends JsonJobStore {
  private threw = false;

  constructor(directory: string) {
    super(directory, () => "2026-07-14T00:00:00.000Z");
  }

  override async update(
    jobId: string,
    mutate: (job: SearchJob) => SearchJob,
  ): Promise<SearchJob> {
    return super.update(jobId, (current) => {
      const next = mutate(current);
      if (!this.threw && next.progress.completedPairs === 1) {
        this.threw = true;
        throw new Error("injected progress write failure");
      }
      return next;
    });
  }
}

describe("createSearchOrchestrator", () => {
  beforeAll(() => {
    vi.setConfig({ testTimeout: 30_000 });
  });

  let directory = "";
  let store: JsonJobStore;
  let google: ControllableProvider;
  let naver: ControllableProvider;
  let jobCounter = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "search-way-"));
    store = new JsonJobStore(directory, () => "2026-07-14T00:00:00.000Z");
    google = new ControllableProvider("google");
    naver = new ControllableProvider("naver");
    jobCounter = 0;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function createOrchestrator(options: {
    store?: JsonJobStore;
    pairs?: DatePair[];
    googleProvider?: ControllableProvider;
    naverProvider?: ControllableProvider;
    config?: Parameters<typeof createSearchOrchestrator>[0]["config"];
  } = {}) {
    return createSearchOrchestrator({
      google: options.googleProvider ?? google,
      naver: options.naverProvider ?? naver,
      store: options.store ?? store,
      generateDatePairs: () => options.pairs ?? threePairs,
      createJobId: () => `job-${++jobCounter}`,
      config: {
        minDelayMs: 0,
        maxDelayMs: 0,
        random: () => 0,
        sleep: async () => undefined,
        ...options.config,
      },
    });
  }

  async function finishJob(orchestrator: ReturnType<typeof createOrchestrator>, jobId: string): Promise<void> {
    const totalPairs = (await orchestrator.getStatus(jobId)).progress.totalPairs;
    await eventually(async () => {
      while (google.pending.length > 0) {
        google.resolveNext(200_000);
      }
      while (naver.pending.length > 0) {
        naver.resolveNext(190_000);
      }
      const status = await orchestrator.getStatus(jobId);
      if (status.progress.completedPairs < totalPairs) {
        throw new Error(`waiting for completion: ${status.progress.completedPairs}/${totalPairs}`);
      }
    }, 15_000);
    await orchestrator.waitForIdle(jobId);
  }

  it("waits for both cells before incrementing completedPairs", async () => {
    const orchestrator = createOrchestrator();
    const started = await orchestrator.start(request);
    expect(started).toEqual({ jobId: "job-1", totalPairs: 3, status: "queued" });

    await eventually(() => {
      expect(google.calls).toHaveLength(2);
      expect(naver.calls).toHaveLength(2);
    });
    expect((await orchestrator.getStatus("job-1")).status).toBe("running");

    google.resolveNext(200_000);
    await Promise.resolve();
    expect((await orchestrator.getStatus("job-1")).progress.completedPairs).toBe(0);

    naver.resolveNext(190_000);
    await eventually(async () => {
      const status = await orchestrator.getStatus("job-1");
      expect(status.progress.completedPairs).toBe(1);
      expect(status.results.map((row) => row.best.price)).toEqual([190_000]);
    });

    await orchestrator.cancel("job-1");
    while (google.pending.length > 0) {
      google.resolveNext(200_000);
    }
    while (naver.pending.length > 0) {
      naver.resolveNext(190_000);
    }
    await orchestrator.waitForIdle("job-1");
  });

  it("persists running before provider invocation", async () => {
    const orderStore = new JsonJobStore(directory, () => "2026-07-14T00:00:00.000Z");
    const orderGoogle = new StatusObservingProvider("google", async () =>
      (await orderStore.get("job-1")).status,
    );
    const orderNaver = new StatusObservingProvider("naver", async () =>
      (await orderStore.get("job-1")).status,
    );
    const orchestrator = createOrchestrator({
      store: orderStore,
      pairs: [threePairs[0]!],
      googleProvider: orderGoogle,
      naverProvider: orderNaver,
    });

    await orchestrator.start(request);
    await eventually(() => {
      expect(orderGoogle.calls).toHaveLength(1);
      expect(orderNaver.calls).toHaveLength(1);
    });
    await eventually(
      () => {
        expect(orderGoogle.observedStatuses).toContain("running");
        expect(orderNaver.observedStatuses).toContain("running");
      },
      3_000,
    );

    await orchestrator.cancel("job-1");
    while (orderGoogle.pending.length > 0) {
      orderGoogle.resolveNext(100_000);
    }
    while (orderNaver.pending.length > 0) {
      orderNaver.resolveNext(100_000);
    }
    await orchestrator.waitForIdle("job-1");
  });

  it("sorts final results and completes all pairs", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.start(request);
    await eventually(() => expect(google.calls.length).toBeGreaterThan(0));

    await finishJob(orchestrator, "job-1");
    const status = await orchestrator.getStatus("job-1");
    expect(status.status).toBe("completed");
    expect(status.progress.completedPairs).toBe(3);
    expect(status.progress.googleOk).toBe(3);
    expect(status.progress.naverOk).toBe(3);
    expect(status.results).toHaveLength(3);
    expect(status.results.map((row) => row.best.price)).toEqual(
      [...status.results.map((row) => row.best.price)].sort((a, b) => a - b),
    );
    expect(google.calls).toHaveLength(3);
    expect(naver.calls).toHaveLength(3);
  });

  it("accounts for partial success, both-source failure, and currency mismatch", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.start(request);

    await eventually(() => expect(google.calls).toHaveLength(2));
    google.resolveNext(100_000);
    naver.rejectNext("naver failed");
    await eventually(async () =>
      expect((await orchestrator.getStatus("job-1")).progress.completedPairs).toBe(1),
    );

    google.rejectNext("google failed");
    naver.rejectNext("naver failed");
    await eventually(async () =>
      expect((await orchestrator.getStatus("job-1")).progress.completedPairs).toBe(2),
    );

    google.resolveNext(100, "USD");
    naver.resolveNext(130_000, "KRW");

    await orchestrator.waitForIdle("job-1");
    const status = await orchestrator.getStatus("job-1");
    expect(status.status).toBe("completed");
    expect(status.progress.completedPairs).toBe(3);
    expect(status.progress.failedPairs).toBe(2);
    expect(status.results).toHaveLength(1);
    expect(status.progress.googleOk).toBe(2);
    expect(status.progress.naverOk).toBe(1);
    expect(status.errors.filter((error) => error.code === "currency_mismatch")).toHaveLength(2);
  });

  it("keeps Google moving while Naver is blocked", async () => {
    const orchestrator = createOrchestrator({ pairs: makePairs(4) });
    await orchestrator.start(request);

    await eventually(() => {
      expect(google.calls).toHaveLength(2);
      expect(naver.calls).toHaveLength(2);
    });

    google.resolveNext(100_000);
    google.resolveNext(110_000);
    await eventually(() => expect(google.calls).toHaveLength(4));
    expect(naver.calls).toHaveLength(2);
    expect((await orchestrator.getStatus("job-1")).progress.completedPairs).toBe(0);

    naver.resolveNext(90_000);
    naver.resolveNext(95_000);
    await finishJob(orchestrator, "job-1");
    expect((await orchestrator.getStatus("job-1")).progress.completedPairs).toBe(4);
  }, 20_000);

  it("shares source schedulers across two jobs", async () => {
    let googleActive = 0;
    let naverActive = 0;
    let googlePeak = 0;
    let naverPeak = 0;
    const gates = {
      google: deferred<void>(),
    };

    const trackingGoogle = new ControllableProvider("google");
    const trackingNaver = new ControllableProvider("naver");
    const originalGoogle = trackingGoogle.findDirectRoundTrip.bind(trackingGoogle);
    trackingGoogle.findDirectRoundTrip = async (input) => {
      googleActive += 1;
      googlePeak = Math.max(googlePeak, googleActive);
      try {
        return await originalGoogle(input);
      } finally {
        googleActive -= 1;
      }
    };
    const originalNaver = trackingNaver.findDirectRoundTrip.bind(trackingNaver);
    trackingNaver.findDirectRoundTrip = async (input) => {
      naverActive += 1;
      naverPeak = Math.max(naverPeak, naverActive);
      try {
        return await originalNaver(input);
      } finally {
        naverActive -= 1;
      }
    };

    const orchestrator = createOrchestrator({
      pairs: makePairs(4),
      googleProvider: trackingGoogle,
      naverProvider: trackingNaver,
      config: {
        limiterHooks: {
          beforeAttempt: async (source) => {
            if (source === "google") {
              await gates.google.promise;
            }
          },
          afterFailure: async () => undefined,
        },
      },
    });

    await Promise.all([orchestrator.start(request), orchestrator.start(request)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(trackingGoogle.calls).toHaveLength(0);
    expect(trackingNaver.calls).toHaveLength(2);
    expect(naverPeak).toBe(2);

    gates.google.resolve();
    await eventually(() => expect(trackingGoogle.calls).toHaveLength(2));
    expect(googlePeak).toBe(2);

    for (const jobId of ["job-1", "job-2"]) {
      await eventually(async () => {
        while (trackingGoogle.pending.length > 0) {
          trackingGoogle.resolveNext(100_000);
        }
        while (trackingNaver.pending.length > 0) {
          trackingNaver.resolveNext(90_000);
        }
        const status = await orchestrator.getStatus(jobId);
        if (status.progress.completedPairs < status.progress.totalPairs) {
          throw new Error(`waiting for ${jobId}`);
        }
      }, 15_000);
      await orchestrator.waitForIdle(jobId);
    }
    expect(googlePeak).toBe(2);
    expect(naverPeak).toBe(2);
  }, 30_000);

  it("cancels cooperatively and preserves partial results", async () => {
    const orchestrator = createOrchestrator({ pairs: makePairs(10) });
    await orchestrator.start(request);

    await eventually(() => {
      expect(google.calls).toHaveLength(2);
      expect(naver.calls).toHaveLength(2);
    });

    await orchestrator.cancel("job-1");
    google.resolveNext(100_000);
    google.resolveNext(110_000);
    naver.resolveNext(90_000);
    naver.resolveNext(95_000);
    await orchestrator.waitForIdle("job-1");

    const status = await orchestrator.getStatus("job-1");
    expect(status.status).toBe("cancelled");
    expect(status.cancellationRequested).toBe(true);
    expect(google.calls).toHaveLength(2);
    expect(naver.calls).toHaveLength(2);
    expect(status.progress.completedPairs).toBe(2);
    expect(status.results).toHaveLength(2);
    expect(status.progress.failedPairs).toBe(0);
  });

  it("does not overwrite terminal jobs on cancel", async () => {
    const orchestrator = createOrchestrator({ pairs: [threePairs[0]!] });
    await orchestrator.start(request);
    await finishJob(orchestrator, "job-1");

    const completedJob = await orchestrator.getStatus("job-1");
    await store.create({
      ...completedJob,
      jobId: "completed-job",
      status: "completed",
    });
    await store.create({
      ...completedJob,
      jobId: "failed-job",
      status: "failed",
      failureReason: "interrupted",
    });

    const completedBefore = await orchestrator.getStatus("completed-job");
    expect(await orchestrator.cancel("completed-job")).toEqual(completedBefore);

    const failedBefore = await orchestrator.getStatus("failed-job");
    expect(await orchestrator.cancel("failed-job")).toEqual(failedBefore);
  });

  it("returns the same snapshot on repeated cancel", async () => {
    const orchestrator = createOrchestrator({ pairs: makePairs(10) });
    await orchestrator.start(request);
    await eventually(() => expect(google.calls).toHaveLength(2));

    const firstCancel = await orchestrator.cancel("job-1");
    const repeatedCancel = await orchestrator.cancel("job-1");
    expect(repeatedCancel).toEqual(firstCancel);
    expect(repeatedCancel.updatedAt).toBe(firstCancel.updatedAt);

    google.resolveNext(100_000);
    naver.resolveNext(90_000);
    google.resolveNext(110_000);
    naver.resolveNext(95_000);
    await orchestrator.waitForIdle("job-1");
  });

  it("stops further provider calls after fatal store failure", async () => {
    const fatalStore = new FailOnceOnProgressStore(directory);
    const heldSleeps: Array<() => void> = [];
    let sleepInvocations = 0;
    const orchestrator = createOrchestrator({
      store: fatalStore,
      pairs: [threePairs[0]!],
      config: {
        concurrencyPerSource: 1,
        sleep: () => {
          sleepInvocations += 1;
          if (sleepInvocations <= 2) {
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            heldSleeps.push(resolve);
          });
        },
      },
    });

    await orchestrator.start(request);
    await eventually(() => expect(google.calls).toHaveLength(1));
    google.resolveNext(100_000);
    naver.resolveNext(90_000);
    await expect(orchestrator.waitForIdle("job-1")).rejects.toThrow(
      "injected progress write failure",
    );

    for (const release of heldSleeps) {
      release();
    }
    await Promise.resolve();
    expect(google.calls).toHaveLength(1);
    expect(naver.calls).toHaveLength(1);
  });

  it("keeps settled run promises observable and prunes bounded runtimes", async () => {
    const orchestrator = createOrchestrator({
      pairs: [threePairs[0]!],
      config: { settledRuntimeLimit: 2 },
    });

    await orchestrator.start(request);
    await finishJob(orchestrator, "job-1");
    await orchestrator.waitForIdle("job-1");
    expect(orchestrator.releaseRuntime("job-1")).toBe(true);
    expect(orchestrator.releaseRuntime("job-1")).toBe(false);

    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const started = await orchestrator.start(request);
      ids.push(started.jobId);
      await finishJob(orchestrator, started.jobId);
    }

    expect(orchestrator.releaseRuntime(ids[0]!)).toBe(false);
    await expect(orchestrator.waitForIdle(ids[0]!)).resolves.toBeUndefined();
    expect(orchestrator.releaseRuntime(ids[1]!)).toBe(true);
    expect(orchestrator.releaseRuntime(ids[2]!)).toBe(true);
  });

  it("G4 completes 50 pairs with immediate providers", async () => {
    const pairs = makePairs(50);
    const immediateGoogle = new ImmediateProvider("google", (input) => ({
      price: Number(input.departureDate.slice(-2)) * 1_000,
      currency: "KRW",
      url: `https://google.example/${input.departureDate}`,
      scrapedAt: "2026-07-14T00:00:00.000Z",
    }));
    const immediateNaver = new ImmediateProvider("naver", (input) => ({
      price: Number(input.departureDate.slice(-2)) * 1_000 + 100,
      currency: "KRW",
      url: `https://naver.example/${input.departureDate}`,
      scrapedAt: "2026-07-14T00:00:00.000Z",
    }));
    const orchestrator = createSearchOrchestrator({
      google: immediateGoogle,
      naver: immediateNaver,
      store,
      generateDatePairs: () => pairs,
      createJobId: () => "g4-complete",
      config: { minDelayMs: 0, maxDelayMs: 0, random: () => 0, sleep: async () => undefined },
    });

    expect(await orchestrator.start(request)).toEqual({
      jobId: "g4-complete",
      totalPairs: 50,
      status: "queued",
    });
    await orchestrator.waitForIdle("g4-complete");
    const status = await orchestrator.getStatus("g4-complete");
    expect(status.status).toBe("completed");
    expect(status.progress).toEqual({
      totalPairs: 50,
      completedPairs: 50,
      failedPairs: 0,
      googleOk: 50,
      naverOk: 50,
    });
    expect(status.results).toHaveLength(50);
    expect(status.results.map((row) => row.best.price)).toEqual(
      [...status.results.map((row) => row.best.price)].sort((a, b) => a - b),
    );
    expect(immediateGoogle.calls).toHaveLength(50);
    expect(immediateNaver.calls).toHaveLength(50);
  });

  it("G4 reports increasing partial status for 50 pairs", async () => {
    const orchestrator = createOrchestrator({ pairs: makePairs(50) });
    await orchestrator.start(request);

    await eventually(() => {
      expect(google.calls).toHaveLength(2);
      expect(naver.calls).toHaveLength(2);
    });
    google.resolveNext(100_000);
    google.resolveNext(110_000);
    naver.resolveNext(90_000);
    naver.resolveNext(95_000);
    await eventually(async () => {
      const status = await orchestrator.getStatus("job-1");
      expect(status.status).toBe("running");
      expect(status.progress.completedPairs).toBe(2);
      expect(status.results).toHaveLength(2);
    });

    await finishJob(orchestrator, "job-1");
    expect((await orchestrator.getStatus("job-1")).progress.completedPairs).toBe(50);
  });

  it("G4 cancels 50 pairs cooperatively", async () => {
    const orchestrator = createOrchestrator({ pairs: makePairs(50) });
    await orchestrator.start(request);

    await eventually(() => {
      expect(google.calls).toHaveLength(2);
      expect(naver.calls).toHaveLength(2);
    });
    await orchestrator.cancel("job-1");
    google.resolveNext(100_000);
    google.resolveNext(110_000);
    naver.resolveNext(90_000);
    naver.resolveNext(95_000);
    await orchestrator.waitForIdle("job-1");

    const status = await orchestrator.getStatus("job-1");
    expect(status.status).toBe("cancelled");
    expect(status.progress.completedPairs).toBe(2);
    expect(status.results).toHaveLength(2);
    expect(google.calls).toHaveLength(2);
    expect(naver.calls).toHaveLength(2);
    expect(status.progress.failedPairs).toBe(0);
  });

  it("recovers interrupted persisted jobs", async () => {
    await store.create({
      jobId: "queued-job",
      status: "queued",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      request,
      progress: {
        totalPairs: 1,
        completedPairs: 0,
        failedPairs: 0,
        googleOk: 0,
        naverOk: 0,
      },
      results: [],
      errors: [],
      cancellationRequested: false,
    });
    await store.create({
      jobId: "running-job",
      status: "running",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      request,
      progress: {
        totalPairs: 1,
        completedPairs: 0,
        failedPairs: 0,
        googleOk: 0,
        naverOk: 0,
      },
      results: [],
      errors: [],
      cancellationRequested: false,
    });
    await store.create({
      jobId: "completed-job",
      status: "completed",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      request,
      progress: {
        totalPairs: 1,
        completedPairs: 1,
        failedPairs: 0,
        googleOk: 1,
        naverOk: 1,
      },
      results: [],
      errors: [],
      cancellationRequested: false,
    });

    const restarted = createOrchestrator({ store });
    expect(await restarted.recoverInterrupted()).toBe(2);
    expect(await restarted.getStatus("queued-job")).toMatchObject({
      status: "failed",
      failureReason: "interrupted",
    });
    expect(await restarted.getStatus("running-job")).toMatchObject({
      status: "failed",
      failureReason: "interrupted",
    });
    expect((await restarted.getStatus("completed-job")).status).toBe("completed");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
