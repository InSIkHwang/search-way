import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeProductionStack } from "../../src/mcp/server.js";
import { SourceScheduler } from "../../src/orchestrator/queue.js";

describe("composeProductionStack runtime wiring", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "search-way-runtime-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("creates shared schedulers and runtime limits", () => {
    const createScheduler = vi.fn((options: ConstructorParameters<typeof SourceScheduler>[0]) =>
      new SourceScheduler(options),
    );
    const stack = composeProductionStack({
      env: {
        SEARCH_WAY_OFFLINE_SMOKE: "1",
        SEARCH_WAY_DATA_DIR: directory,
      },
      createScheduler,
    });

    expect(createScheduler).toHaveBeenCalledTimes(2);
    expect(createScheduler).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source: "google",
        concurrency: 6,
        retryBaseDelayMs: 1000,
        now: expect.any(Function),
        limiterHooks: expect.any(Object),
      }),
    );
    expect(createScheduler).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ source: "naver", concurrency: 6, retryBaseDelayMs: 1000 }),
    );
    expect(stack.googleProviderOptions.requestTimeoutMs).toBe(30_000);
    expect(stack.naverProviderOptions.requestTimeoutMs).toBe(30_000);
    expect(stack.orchestratorConfig.retryPolicy.maxAttempts).toBe(4);
    expect(stack.schedulers.google).toBe(createScheduler.mock.results[0]!.value);
    expect(stack.schedulers.naver).toBe(createScheduler.mock.results[1]!.value);
  });

  it("keeps factory fallback when schedulers are omitted", async () => {
    const { createSearchOrchestrator } = await import("../../src/orchestrator/index.js");
    const { JsonJobStore } = await import("../../src/jobs/store.js");
    const orchestrator = createSearchOrchestrator({
      google: { id: "google", findDirectRoundTrip: async () => ({
        price: 1,
        currency: "KRW",
        url: "https://example.test",
        scrapedAt: "2026-07-14T00:00:00.000Z",
      }) },
      naver: { id: "naver", findDirectRoundTrip: async () => ({
        price: 2,
        currency: "KRW",
        url: "https://example.test/2",
        scrapedAt: "2026-07-14T00:00:00.000Z",
      }) },
      store: new JsonJobStore(directory),
      generateDatePairs: (await import("../../src/domain/date-combinator.js")).generateDatePairs,
      createJobId: () => "fallback-job",
      config: { minDelayMs: 0, maxDelayMs: 0 },
    });

    const request = {
      origin: "ICN",
      destination: "NRT",
      months: ["2026-10"],
      minTripDays: 5,
      maxTripDays: 5,
      departureWeekdays: [4],
      returnWeekdays: [1],
    };
    await orchestrator.start(request);
    await orchestrator.waitForIdle("fallback-job");
    expect(await orchestrator.getStatus("fallback-job")).toMatchObject({ status: "completed" });
  });
});
