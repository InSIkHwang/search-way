import { describe, expect, it, vi } from "vitest";
import type { DatePair, FlexibleSearchRequest } from "../../src/domain/types.js";
import { JobNotFoundError } from "../../src/jobs/store.js";
import type { SearchJob } from "../../src/jobs/types.js";
import { createMcpTools, type McpCore } from "../../src/mcp/tools.js";

const validInput = {
  origin: "icn",
  destination: "nrt",
  months: ["2026-10", "2026-10"],
  min_trip_days: 2,
  max_trip_days: 3,
  departure_weekdays: [6, 1],
  return_weekdays: [],
};

const normalizedRequest: FlexibleSearchRequest = {
  origin: "ICN",
  destination: "NRT",
  months: ["2026-10"],
  minTripDays: 2,
  maxTripDays: 3,
  departureWeekdays: [1, 6],
  returnWeekdays: [],
};

const pairA: DatePair = {
  departureDate: "2026-10-01",
  returnDate: "2026-10-02",
  tripDays: 2,
};
const pairB: DatePair = {
  departureDate: "2026-10-02",
  returnDate: "2026-10-04",
  tripDays: 3,
};

const runningJob = (): SearchJob => ({
  jobId: "job-1",
  status: "running",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:10.000Z",
  request: normalizedRequest,
  progress: {
    totalPairs: 2,
    completedPairs: 1,
    failedPairs: 0,
    googleOk: 1,
    naverOk: 0,
  },
  results: [{
    departureDate: "2026-10-01",
    returnDate: "2026-10-02",
    tripDays: 2,
    google: {
      price: 300_000,
      currency: "KRW",
      url: "https://example.test/300000",
      scrapedAt: "2026-07-14T00:00:05.000Z",
    },
    naver: null,
    best: {
      price: 300_000,
      currency: "KRW",
      url: "https://example.test/300000",
      scrapedAt: "2026-07-14T00:00:05.000Z",
      source: "google",
    },
  }],
  errors: [],
  cancellationRequested: false,
});

function createFakeCore(): McpCore {
  return {
    enumerateDatePairs: vi.fn<McpCore["enumerateDatePairs"]>(),
    start: vi.fn<McpCore["start"]>(),
    getStatus: vi.fn<McpCore["getStatus"]>(),
    cancel: vi.fn<McpCore["cancel"]>(),
    waitForIdle: vi.fn<McpCore["waitForIdle"]>(),
    recoverInterrupted: vi.fn<McpCore["recoverInterrupted"]>(),
  };
}

describe("createMcpTools", () => {
  it("rejects invalid input before enumerate/start", async () => {
    const core = createFakeCore();
    const tools = createMcpTools(core);

    const result = await tools.start({ ...validInput, origin: "SEOUL" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(core.enumerateDatePairs).not.toHaveBeenCalled();
    expect(core.start).not.toHaveBeenCalled();
  });

  it("rejects zero pairs before start", async () => {
    const core = createFakeCore();
    core.enumerateDatePairs.mockReturnValue([]);
    const tools = createMcpTools(core);

    const result = await tools.start(validInput);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "EMPTY_DATE_PAIRS",
        message: "No date pairs match the search conditions",
      },
    });
    expect(core.start).not.toHaveBeenCalled();
  });

  it("returns the queued StartSearchResult without waiting for idle", async () => {
    const core = createFakeCore();
    core.enumerateDatePairs.mockReturnValue([pairA, pairB]);
    core.start.mockResolvedValue({
      jobId: "job-1",
      totalPairs: 2,
      status: "queued",
    });
    core.waitForIdle.mockReturnValue(new Promise<void>(() => undefined));
    const tools = createMcpTools(core);

    const result = await tools.start(validInput);

    expect(result).toEqual({
      ok: true,
      value: { job_id: "job-1", total_pairs: 2, status: "queued" },
    });
    expect(core.start).toHaveBeenCalledTimes(1);
    expect(core.start).toHaveBeenCalledWith(normalizedRequest);
    expect(core.waitForIdle).not.toHaveBeenCalled();
  });

  it("maps start rejection to INTERNAL_ERROR without retry", async () => {
    const core = createFakeCore();
    core.enumerateDatePairs.mockReturnValue([pairA]);
    core.start.mockRejectedValue(new Error("store unavailable"));
    const tools = createMcpTools(core);

    await expect(tools.start(validInput)).resolves.toEqual({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to start search",
      },
    });
    expect(core.start).toHaveBeenCalledTimes(1);
    expect(core.cancel).not.toHaveBeenCalled();
    expect(core.waitForIdle).not.toHaveBeenCalled();
  });

  it("rejects a start result whose totalPairs differs from the precheck", async () => {
    const core = createFakeCore();
    core.enumerateDatePairs.mockReturnValue([pairA, pairB]);
    core.start.mockResolvedValue({
      jobId: "job-1",
      totalPairs: 1,
      status: "queued",
    });
    const tools = createMcpTools(core);

    await expect(tools.start(validInput)).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
  });

  it("returns idempotent partial status sorted and serialized", async () => {
    const core = createFakeCore();
    core.getStatus.mockResolvedValue(runningJob());
    const tools = createMcpTools(core);

    const result = await tools.getStatus({ job_id: "job-1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        job_id: "job-1",
        status: "running",
        progress: { total_pairs: 2 },
      });
      expect(result.value.results).toEqual([
        expect.objectContaining({
          departure_date: "2026-10-01",
          best: expect.objectContaining({ scraped_at: "2026-07-14T00:00:05.000Z" }),
        }),
      ]);
    }
  });

  it("maps an unknown status job id to JOB_NOT_FOUND", async () => {
    const core = createFakeCore();
    core.getStatus.mockRejectedValue(new JobNotFoundError("missing"));
    const tools = createMcpTools(core);

    await expect(tools.getStatus({ job_id: "missing" })).resolves.toEqual({
      ok: false,
      error: {
        code: "JOB_NOT_FOUND",
        message: "Unknown job_id: missing",
      },
    });
  });

  it("delegates cooperative cancellation and preserves partial results", async () => {
    const core = createFakeCore();
    core.cancel.mockResolvedValue({ ...runningJob(), status: "cancelled" });
    const tools = createMcpTools(core);

    await expect(tools.cancel({ job_id: "job-1" })).resolves.toEqual({
      ok: true,
      value: { job_id: "job-1", status: "cancelled" },
    });
  });

  it.each(["cancelled", "completed", "failed"] as const)(
    "keeps terminal %s cancellation idempotent",
    async (status) => {
      const core = createFakeCore();
      core.cancel.mockResolvedValue({ ...runningJob(), status });
      const tools = createMcpTools(core);

      await expect(tools.cancel({ job_id: "job-1" })).resolves.toEqual({
        ok: true,
        value: { job_id: "job-1", status },
      });
    },
  );

  it("maps an unknown cancel job id to JOB_NOT_FOUND", async () => {
    const core = createFakeCore();
    core.cancel.mockRejectedValue(new JobNotFoundError("missing"));
    const tools = createMcpTools(core);

    await expect(tools.cancel({ job_id: "missing" })).resolves.toEqual({
      ok: false,
      error: {
        code: "JOB_NOT_FOUND",
        message: "Unknown job_id: missing",
      },
    });
  });
});
