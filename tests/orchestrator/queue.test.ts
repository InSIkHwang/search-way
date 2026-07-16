import { describe, expect, it, vi } from "vitest";
import { SourceScheduler } from "../../src/orchestrator/queue.js";
import type { Quote } from "../../src/providers/types.js";

const quote: Quote = {
  price: 1,
  currency: "KRW",
  url: "https://example.test",
  scrapedAt: "2026-07-14T00:00:00.000Z",
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const activeToken = { shouldStop: () => false };
const noOpHooks = {
  beforeAttempt: async () => undefined,
  afterFailure: async () => undefined,
};

const baseSchedulerOptions = (overrides: Partial<ConstructorParameters<typeof SourceScheduler>[0]> = {}) => ({
  source: "google" as const,
  concurrency: 2,
  minDelayMs: 0,
  maxDelayMs: 0,
  random: () => 0,
  sleep: async () => undefined,
  now: () => "2026-07-14T00:00:00.000Z",
  retryBaseDelayMs: 1_000,
  retryPolicy: { maxAttempts: 1, shouldRetry: () => false },
  limiterHooks: noOpHooks,
  ...overrides,
});

describe("SourceScheduler", () => {
  it("never exceeds source concurrency 2", async () => {
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 3 }, () => deferred<Quote>());
    const scheduler = new SourceScheduler(baseSchedulerOptions());
    const outcomes = gates.map((gate) =>
      scheduler.add(async () => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          return await gate.promise;
        } finally {
          active -= 1;
        }
      }, activeToken),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(2);
    gates[0]!.resolve(quote);
    gates[1]!.resolve(quote);
    await Promise.resolve();
    gates[2]!.resolve(quote);
    await Promise.all(outcomes);
    expect(peak).toBe(2);
  });

  it("injects inclusive jitter before invoking a provider", async () => {
    const events: string[] = [];
    const scheduler = new SourceScheduler(baseSchedulerOptions({
      source: "naver",
      concurrency: 1,
      minDelayMs: 500,
      maxDelayMs: 1500,
      random: () => 0.25,
      sleep: vi.fn(async (milliseconds) => {
        events.push(`sleep:${milliseconds}`);
      }),
      limiterHooks: {
        beforeAttempt: async () => {
          events.push("beforeAttempt");
        },
        afterFailure: async () => undefined,
      },
    }));
    await scheduler.add(async () => {
      events.push("provider");
      return quote;
    }, activeToken);
    expect(events).toEqual(["sleep:750", "beforeAttempt", "provider"]);
  });

  it("does not start queued work after cooperative cancellation", async () => {
    let cancelled = false;
    const gate = deferred<Quote>();
    const provider = vi.fn(async () => gate.promise);
    const scheduler = new SourceScheduler(baseSchedulerOptions({
      source: "google",
      concurrency: 1,
    }));
    const token = { shouldStop: () => cancelled };
    const first = scheduler.add(provider, token);
    const second = scheduler.add(provider, token);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelled = true;
    gate.resolve(quote);
    await first;
    expect(await second).toEqual({ kind: "cancelled", source: "google" });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("attempts a failing cell once with the Phase 1 default policy", async () => {
    const afterFailure = vi.fn(async () => undefined);
    const provider = vi.fn(async () => {
      throw new Error("blocked");
    });
    const scheduler = new SourceScheduler(baseSchedulerOptions({
      source: "naver",
      limiterHooks: {
        beforeAttempt: async () => undefined,
        afterFailure,
      },
    }));
    const outcome = await scheduler.add(provider, activeToken);
    expect(outcome.kind).toBe("failure");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(afterFailure).toHaveBeenCalledWith("naver", expect.any(Error));
  });
});
