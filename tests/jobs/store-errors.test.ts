import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateDatePairs } from "../../src/domain/date-combinator.js";
import type { FlexibleSearchRequest } from "../../src/domain/types.js";
import { JobStoreError, JsonJobStore, type JobStoreFilesystem } from "../../src/jobs/store.js";
import type { SearchJob } from "../../src/jobs/types.js";
import { createSearchOrchestrator } from "../../src/orchestrator/index.js";
import type {
  FlightProvider,
  ProviderSearchInput,
  Quote,
} from "../../src/providers/types.js";

const quote: Quote = {
  price: 100_000,
  currency: "KRW",
  url: "https://example.test",
  scrapedAt: "2026-07-14T00:00:00.000Z",
};

class StableProvider implements FlightProvider {
  constructor(readonly id: "google" | "naver") {}
  async findDirectRoundTrip(_input: ProviderSearchInput): Promise<Quote> {
    return quote;
  }
}

describe("JsonJobStore errors", () => {
  const job: SearchJob = {
    jobId: "store-job",
    status: "running",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    request: {
      origin: "ICN",
      destination: "NRT",
      months: ["2026-10"],
      minTripDays: 5,
      maxTripDays: 5,
      departureWeekdays: [],
      returnWeekdays: [],
    },
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
  };

  it("wraps write failures and preserves the last durable snapshot", async () => {
    const durable = structuredClone(job);
    const filesystem: JobStoreFilesystem = {
      mkdir: async () => undefined,
      readdir: async () => [],
      readFile: async () => `${JSON.stringify(durable, null, 2)}\n`,
      writeFile: async () => {
        const error = Object.assign(new Error("no space"), { code: "ENOSPC" });
        throw error;
      },
      rename: async () => undefined,
      unlink: async () => undefined,
    };
    const store = new JsonJobStore("/tmp/store", () => "2026-07-14T00:00:00.000Z", filesystem);

    await expect(store.update("store-job", (current) => ({
      ...current,
      updatedAt: "2026-07-14T00:00:01.000Z",
    }))).rejects.toMatchObject({
      name: "JobStoreError",
      cause: expect.objectContaining({ code: "ENOSPC" }),
    });
    expect(await store.get("store-job")).toEqual(durable);
  });

  it("rejects malformed JSON during recovery", async () => {
    const filesystem: JobStoreFilesystem = {
      mkdir: async () => undefined,
      readdir: async () => ["broken.json"],
      readFile: async () => "{not-json",
      writeFile: async () => undefined,
      rename: async () => undefined,
      unlink: async () => undefined,
    };
    const store = new JsonJobStore("/tmp/store", () => "2026-07-14T00:00:00.000Z", filesystem);
    await expect(store.markInterrupted()).rejects.toMatchObject({
      name: "JobStoreError",
      cause: expect.any(SyntaxError),
    });
  });
});

describe("orchestrator store failure boundary", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "search-way-store-error-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("persists store_error when a progress write fails once", async () => {
    let writes = 0;
    const baseStore = new JsonJobStore(directory);
    const store = new JsonJobStore(directory);
    const originalUpdate = store.update.bind(store);
    store.update = async (jobId, mutate) => {
      writes += 1;
      if (writes === 2) {
        throw new JobStoreError("progress write failed");
      }
      return originalUpdate(jobId, mutate);
    };

    const request: FlexibleSearchRequest = {
      origin: "ICN",
      destination: "NRT",
      months: ["2026-10"],
      minTripDays: 5,
      maxTripDays: 5,
      departureWeekdays: [4],
      returnWeekdays: [1],
    };

    const orchestrator = createSearchOrchestrator({
      google: new StableProvider("google"),
      naver: new StableProvider("naver"),
      store,
      generateDatePairs,
      createJobId: () => "store-fail-job",
      config: {
        minDelayMs: 0,
        maxDelayMs: 0,
        random: () => 0,
        sleep: async () => undefined,
        now: () => "2026-07-14T00:00:00.000Z",
      },
    });

    await orchestrator.start(request);
    await expect(orchestrator.waitForIdle("store-fail-job")).rejects.toBeInstanceOf(JobStoreError);
    expect(await orchestrator.getStatus("store-fail-job")).toMatchObject({
      status: "failed",
      failureReason: "store_error",
    });
    expect(baseStore).toBeDefined();
  });
});
