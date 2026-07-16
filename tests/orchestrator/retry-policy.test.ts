import { describe, expect, it, vi } from "vitest";
import { createOrchestratorConfig } from "../../src/orchestrator/config.js";
import { SourceScheduler } from "../../src/orchestrator/queue.js";

const schedulerOptions = (
  config: ReturnType<typeof createOrchestratorConfig>,
  overrides: Partial<Parameters<typeof SourceScheduler>[0]> = {},
) => ({
  source: "google" as const,
  concurrency: 1,
  minDelayMs: config.minDelayMs,
  maxDelayMs: config.maxDelayMs,
  random: config.random,
  sleep: config.sleep,
  now: config.now,
  retryBaseDelayMs: config.retryBaseDelayMs,
  retryPolicy: config.retryPolicy,
  limiterHooks: config.limiterHooks,
  ...overrides,
});

describe("Phase 4 retry through global SourceScheduler", () => {
  it("uses deterministic 1s, 2s, 4s delays and four total attempts", async () => {
    const sleep = vi.fn(async () => undefined);
    const config = createOrchestratorConfig({
      minDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0.5,
      sleep,
      now: () => "2026-07-14T00:00:00.000Z",
    });
    expect(config.retryBaseDelayMs).toBe(1_000);
    const scheduler = new SourceScheduler(schedulerOptions(config, { sleep }));
    const provider = vi.fn().mockRejectedValue({ code: "provider_timeout" });

    await expect(scheduler.add(
      provider,
      { shouldStop: () => false },
    )).resolves.toMatchObject({
      kind: "failure",
      source: "google",
    });
    expect(provider).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_000,
      2_000,
      4_000,
    ]);
  });

  it("does not retry a lowercase source-local no_direct_flight code", async () => {
    const sleep = vi.fn(async () => undefined);
    const config = createOrchestratorConfig({ minDelayMs: 0, maxDelayMs: 0, sleep });
    const scheduler = new SourceScheduler(schedulerOptions(config, {
      source: "naver",
      sleep,
      random: () => 0.5,
    }));
    const provider = vi.fn().mockRejectedValue({ code: "no_direct_flight" });

    await scheduler.add(provider, { shouldStop: () => false });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
