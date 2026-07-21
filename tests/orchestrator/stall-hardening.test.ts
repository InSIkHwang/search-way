import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatePair, FlexibleSearchRequest } from "../../src/domain/types.js";
import { JsonJobStore } from "../../src/jobs/store.js";
import { createSearchOrchestrator } from "../../src/orchestrator/index.js";
import { SourceScheduler } from "../../src/orchestrator/queue.js";
import type {
  FlightProvider,
  ProviderId,
  ProviderSearchInput,
  Quote,
} from "../../src/providers/types.js";
import { eventually } from "../helpers/eventually.js";

const quote: Quote = {
  price: 1,
  currency: "KRW",
  url: "https://example.test",
  scrapedAt: "2026-07-14T00:00:00.000Z",
};

const abortError = () => Object.assign(new Error("Aborted"), { name: "AbortError" });

const noOpHooks = {
  beforeAttempt: async () => undefined,
  afterFailure: async () => undefined,
};

const baseSchedulerOptions = (
  overrides: Partial<ConstructorParameters<typeof SourceScheduler>[0]> = {},
) => ({
  source: "google" as const,
  concurrency: 1,
  minDelayMs: 0,
  maxDelayMs: 0,
  random: () => 0,
  sleep: async () => undefined,
  now: () => new Date().toISOString(),
  retryBaseDelayMs: 1,
  retryPolicy: { maxAttempts: 1, shouldRetry: () => false },
  limiterHooks: noOpHooks,
  taskDeadlineMs: 40,
  taskKillGraceMs: 30,
  ...overrides,
});

const activeToken = { shouldStop: () => false };

/** Never settles on its own; rejects with AbortError once the signal fires. */
const hangUntilAbort = (signal: AbortSignal) =>
  new Promise<Quote>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });

/** Never settles, no matter what — simulates a wedged Playwright call. */
const hangForever = () => new Promise<Quote>(() => undefined);

describe("SourceScheduler hard deadline", () => {
  it("aborts a hung task at the deadline and frees the slot", async () => {
    const scheduler = new SourceScheduler(baseSchedulerOptions());

    const first = await scheduler.add(hangUntilAbort, activeToken);
    expect(first.kind).toBe("failure");

    const second = await scheduler.add(async () => quote, activeToken);
    expect(second).toEqual({ kind: "success", source: "google", quote });
  });

  it("reclaims the slot even when the task ignores abort entirely", async () => {
    const scheduler = new SourceScheduler(baseSchedulerOptions());

    const first = await scheduler.add(hangForever, activeToken);
    expect(first.kind).toBe("failure");
    if (first.kind === "failure") {
      expect((first.cause as Error).name).toBe("TimeoutError");
    }

    const second = await scheduler.add(async () => quote, activeToken);
    expect(second.kind).toBe("success");
  });

  it("cancels an in-flight task when the token signal aborts", async () => {
    const scheduler = new SourceScheduler(
      baseSchedulerOptions({ taskDeadlineMs: 60_000 }),
    );
    const controller = new AbortController();
    const token = { shouldStop: () => controller.signal.aborted, signal: controller.signal };

    const seen: AbortSignal[] = [];
    const outcome = scheduler.add((signal) => {
      seen.push(signal);
      return hangUntilAbort(signal);
    }, token);
    await eventually(() => expect(seen).toHaveLength(1));

    controller.abort();
    expect(await outcome).toEqual({ kind: "cancelled", source: "google" });
    expect(seen[0]!.aborted).toBe(true);

    const next = await scheduler.add(async () => quote, activeToken);
    expect(next.kind).toBe("success");
  });
});

class ScriptedProvider implements FlightProvider {
  readonly signals: AbortSignal[] = [];
  readonly calls: ProviderSearchInput[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly behave: (
      input: ProviderSearchInput,
      signal: AbortSignal | undefined,
    ) => Promise<Quote>,
  ) {}

  findDirectRoundTrip(input: ProviderSearchInput, signal?: AbortSignal): Promise<Quote> {
    this.calls.push(structuredClone(input));
    if (signal !== undefined) {
      this.signals.push(signal);
    }
    return this.behave(input, signal);
  }
}

const onePair: DatePair[] = [
  { departureDate: "2026-10-01", returnDate: "2026-10-05", tripDays: 5 },
];

const makeRequest = (destination: string): FlexibleSearchRequest => ({
  origin: "PUS",
  destination,
  months: ["2026-10"],
  minTripDays: 5,
  maxTripDays: 5,
  departureWeekdays: [],
  returnWeekdays: [],
});

describe("orchestrator stall hardening", () => {
  let directory = "";
  let store: JsonJobStore;
  let jobCounter = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "search-way-stall-"));
    store = new JsonJobStore(directory);
    jobCounter = 0;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function createOrchestrator(options: {
    google: ScriptedProvider;
    naver: ScriptedProvider;
    config?: Parameters<typeof createSearchOrchestrator>[0]["config"];
  }) {
    return createSearchOrchestrator({
      google: options.google,
      naver: options.naver,
      store,
      generateDatePairs: () => onePair,
      createJobId: () => `job-${++jobCounter}`,
      config: {
        minDelayMs: 0,
        maxDelayMs: 0,
        random: () => 0,
        sleep: async () => undefined,
        retryPolicy: { maxAttempts: 1, shouldRetry: () => false },
        ...options.config,
      },
    });
  }

  it("cancel aborts in-flight provider tasks and releases their slots", async () => {
    const google = new ScriptedProvider("google", (_input, signal) =>
      hangUntilAbort(signal!),
    );
    const naver = new ScriptedProvider("naver", (_input, signal) =>
      hangUntilAbort(signal!),
    );
    const orchestrator = createOrchestrator({ google, naver });

    const { jobId } = await orchestrator.start(makeRequest("PQC"));
    await eventually(() => expect(google.signals).toHaveLength(1));
    expect(google.signals[0]!.aborted).toBe(false);

    await orchestrator.cancel(jobId);

    await orchestrator.waitForIdle(jobId);
    expect(google.signals[0]!.aborted).toBe(true);
    expect((await orchestrator.getStatus(jobId)).status).toBe("cancelled");
  });

  it("a job whose tasks hang cannot starve a later job on the shared schedulers", async () => {
    const behave = async (input: ProviderSearchInput): Promise<Quote> => {
      if (input.destination === "PQC") {
        return hangForever();
      }
      return quote;
    };
    const google = new ScriptedProvider("google", behave);
    const naver = new ScriptedProvider("naver", behave);
    const orchestrator = createOrchestrator({
      google,
      naver,
      config: {
        concurrencyPerSource: 1,
        taskDeadlineMs: 40,
        taskKillGraceMs: 30,
        retryPolicy: { maxAttempts: 1, shouldRetry: () => false },
      },
    });

    const jobA = await orchestrator.start(makeRequest("PQC"));
    const jobB = await orchestrator.start(makeRequest("CXR"));

    await orchestrator.waitForIdle(jobB.jobId);
    const statusB = await orchestrator.getStatus(jobB.jobId);
    expect(statusB.status).toBe("completed");
    expect(statusB.progress.completedPairs).toBe(1);

    // The hung job settles too: its cells fail as timeouts instead of pinning
    // the schedulers forever.
    await orchestrator.waitForIdle(jobA.jobId);
    const statusA = await orchestrator.getStatus(jobA.jobId);
    expect(statusA.status).toBe("completed");
    expect(statusA.errors.length).toBeGreaterThan(0);
    expect(statusA.errors.every((error) => error.code === "provider_timeout")).toBe(true);
  });

  it("stall watchdog fails a job with no progress and aborts its work", async () => {
    const google = new ScriptedProvider("google", (_input, signal) =>
      hangUntilAbort(signal!),
    );
    const naver = new ScriptedProvider("naver", (_input, signal) =>
      hangUntilAbort(signal!),
    );
    const orchestrator = createOrchestrator({
      google,
      naver,
      config: {
        taskDeadlineMs: 60_000,
        stallTimeoutMs: 80,
        stallCheckIntervalMs: 20,
      },
    });

    const { jobId } = await orchestrator.start(makeRequest("PQC"));
    await orchestrator.waitForIdle(jobId);

    const status = await orchestrator.getStatus(jobId);
    expect(status.status).toBe("failed");
    expect(status.failureReason).toBe("stalled");
    expect(google.signals[0]!.aborted).toBe(true);
  });
});
