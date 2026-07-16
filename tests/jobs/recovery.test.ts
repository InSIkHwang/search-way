import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonJobStore } from "../../src/jobs/store.js";
import type { SearchJob } from "../../src/jobs/types.js";

describe("markInterrupted recovery", () => {
  let directory: string;
  const now = () => "2026-07-14T12:00:00.000Z";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "search-way-recovery-"));
    await mkdir(directory, { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeJob(job: SearchJob): Promise<void> {
    await writeFile(
      join(directory, `${job.jobId}.json`),
      `${JSON.stringify(job, null, 2)}\n`,
      "utf8",
    );
  }

  const baseJob = (jobId: string, status: SearchJob["status"]): SearchJob => ({
    jobId,
    status,
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
      completedPairs: status === "completed" ? 1 : 0,
      failedPairs: 0,
      googleOk: status === "completed" ? 1 : 0,
      naverOk: 0,
    },
    results: status === "completed"
      ? [{
          departureDate: "2026-10-08",
          returnDate: "2026-10-12",
          tripDays: 5,
          google: {
            price: 100_000,
            currency: "KRW",
            url: "https://example.test",
            scrapedAt: "2026-07-14T00:00:00.000Z",
          },
          naver: null,
          best: {
            price: 100_000,
            currency: "KRW",
            url: "https://example.test",
            scrapedAt: "2026-07-14T00:00:00.000Z",
            source: "google",
          },
        }]
      : [],
    errors: [],
    cancellationRequested: false,
  });

  it("marks queued and running jobs interrupted with injected now", async () => {
    const runningId = "running-job";
    const queuedId = "queued-job";
    const completedId = "completed-job";
    await writeJob(baseJob(runningId, "running"));
    await writeJob(baseJob(queuedId, "queued"));
    await writeJob(baseJob(completedId, "completed"));

    const store = new JsonJobStore(directory, now);
    expect(await store.markInterrupted()).toBe(2);
    expect(await store.get(runningId)).toMatchObject({
      status: "failed",
      failureReason: "interrupted",
      updatedAt: now(),
    });
    expect(await store.get(queuedId)).toMatchObject({
      status: "failed",
      failureReason: "interrupted",
    });
    expect((await store.get(completedId)).failureReason).toBeUndefined();
    expect(await store.markInterrupted()).toBe(0);
  });
});
