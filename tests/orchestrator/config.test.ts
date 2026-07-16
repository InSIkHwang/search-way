import { describe, expect, it, vi } from "vitest";
import { createOrchestratorConfig } from "../../src/orchestrator/config.js";

describe("createOrchestratorConfig", () => {
  it("uses polite defaults with transient retries", () => {
    const config = createOrchestratorConfig();

    expect(config.concurrencyPerSource).toBe(2);
    expect(config.minDelayMs).toBe(500);
    expect(config.maxDelayMs).toBe(1500);
    expect(config.retryBaseDelayMs).toBe(1000);
    expect(config.retryPolicy.maxAttempts).toBe(4);
    expect(config.retryPolicy.shouldRetry({ code: "provider_timeout" }, 1)).toBe(true);
    expect(config.retryPolicy.shouldRetry({ code: "no_direct_flight" }, 1)).toBe(false);
    expect(config.settledRuntimeLimit).toBe(100);
  });

  it("keeps clock, limiter hooks, random, sleep, and retry policy injectable", async () => {
    const sleep = vi.fn(async () => undefined);
    const beforeAttempt = vi.fn(async () => undefined);
    const afterFailure = vi.fn(async () => undefined);
    const now = () => "2026-07-14T00:00:00.000Z";
    const config = createOrchestratorConfig({
      minDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0.25,
      sleep,
      now,
      retryPolicy: { maxAttempts: 2, shouldRetry: () => true },
      limiterHooks: { beforeAttempt, afterFailure },
      settledRuntimeLimit: 7,
    });

    await config.sleep(7);
    await config.limiterHooks.beforeAttempt("google");
    await config.limiterHooks.afterFailure("google", new Error("429"));
    expect(sleep).toHaveBeenCalledWith(7);
    expect(beforeAttempt).toHaveBeenCalledWith("google");
    expect(afterFailure).toHaveBeenCalledOnce();
    expect(config.now()).toBe("2026-07-14T00:00:00.000Z");
    expect(config.retryPolicy.maxAttempts).toBe(2);
    expect(config.settledRuntimeLimit).toBe(7);
  });

  it.each([
    [{ concurrencyPerSource: 0 }, "concurrencyPerSource"],
    [{ minDelayMs: -1 }, "minDelayMs"],
    [{ minDelayMs: 10, maxDelayMs: 9 }, "maxDelayMs"],
    [{ retryPolicy: { maxAttempts: 0 } }, "maxAttempts"],
    [{ settledRuntimeLimit: 0 }, "settledRuntimeLimit"],
  ])("rejects invalid override %j", (override, field) => {
    expect(() => createOrchestratorConfig(override)).toThrow(field);
  });
});
