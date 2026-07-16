import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonJobStore } from "../../src/jobs/store.js";
import type { SearchJob } from "../../src/jobs/types.js";

const job: SearchJob = {
  jobId: "job-1",
  status: "queued",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
  request: {
    origin: "ICN",
    destination: "NRT",
    months: ["2026-10"],
    minTripDays: 4,
    maxTripDays: 4,
    departureWeekdays: [],
    returnWeekdays: [],
  },
  progress: {
    totalPairs: 3,
    completedPairs: 0,
    failedPairs: 0,
    googleOk: 0,
    naverOk: 0,
  },
  results: [],
  errors: [],
  cancellationRequested: false,
};

describe("JsonJobStore", () => {
  let directory = "";
  let store: JsonJobStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "search-way-"));
    store = new JsonJobStore(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips a cloned job snapshot", async () => {
    await store.create(job);
    const read = await store.get(job.jobId);
    read.progress.completedPairs = 99;
    expect((await store.get(job.jobId)).progress.completedPairs).toBe(0);
  });

  it("serializes concurrent updates for one job without lost increments", async () => {
    await store.create(job);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.update(job.jobId, (current) => ({
          ...current,
          progress: {
            ...current.progress,
            completedPairs: current.progress.completedPairs + 1,
          },
        })),
      ),
    );
    expect((await store.get(job.jobId)).progress.completedPairs).toBe(20);
  });

  it("leaves only the final json after atomic temp plus rename", async () => {
    await store.create(job);
    await store.update(job.jobId, (current) => ({ ...current, status: "running" }));
    expect((await readdir(directory)).sort()).toEqual([`${job.jobId}.json`]);
    expect(JSON.parse(await readFile(join(directory, `${job.jobId}.json`), "utf8"))).toMatchObject({
      jobId: job.jobId,
      status: "running",
    });
  });

  it("marks queued and running jobs interrupted after restart", async () => {
    await store.create(job);
    await store.create({ ...job, jobId: "completed-job", status: "completed" });
    const restarted = new JsonJobStore(directory, () => "2026-07-14T01:00:00.000Z");
    expect(await restarted.markInterrupted()).toBe(1);
    expect(await restarted.get(job.jobId)).toMatchObject({
      status: "failed",
      failureReason: "interrupted",
      updatedAt: "2026-07-14T01:00:00.000Z",
    });
    expect((await restarted.get("completed-job")).status).toBe("completed");
  });

  it("rejects traversal-shaped job ids", async () => {
    await expect(store.get("../outside")).rejects.toThrow("Invalid job id");
  });
});
