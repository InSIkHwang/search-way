import { describe, expect, it, vi } from "vitest";
import { createOrchestratorConfig } from "../../src/orchestrator/config.js";
import { SourceScheduler } from "../../src/orchestrator/queue.js";

describe("global source pause across queued work", () => {
  it("pauses all Google tasks after a 429 and resumes after the pause elapses", async () => {
    let nowMs = Date.parse("2026-07-14T00:00:00.000Z");
    const events: string[] = [];
    let releasePause: (() => void) | null = null;

    const sleep = vi.fn(async (milliseconds: number) => {
      if (milliseconds >= 9_000) {
        events.push(`sleep:${milliseconds}`);
        await new Promise<void>((resolve) => {
          releasePause = resolve;
        });
      }
    });

    const config = createOrchestratorConfig({
      minDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0.5,
      sleep,
      now: () => new Date(nowMs).toISOString(),
    });

    const scheduler = new SourceScheduler({
      source: "google",
      concurrency: 1,
      minDelayMs: 0,
      maxDelayMs: 0,
      random: config.random,
      sleep: config.sleep,
      now: config.now,
      retryBaseDelayMs: config.retryBaseDelayMs,
      retryPolicy: config.retryPolicy,
      limiterHooks: config.limiterHooks,
    });

    let calls = 0;
    const failingTask = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        events.push("task-a:429");
        throw Object.assign(new Error("rate limited"), {
          code: "provider_blocked",
          status: 429,
          retryAfter: "9",
        });
      }
      events.push("task-a:success");
      return {
        price: 100_000,
        currency: "KRW" as const,
        url: "https://example.test",
        scrapedAt: "2026-07-14T00:00:00.000Z",
      };
    });

    const blockedTask = vi.fn(async () => {
      events.push("task-b:blocked");
      return {
        price: 110_000,
        currency: "KRW" as const,
        url: "https://example.test/2",
        scrapedAt: "2026-07-14T00:00:00.000Z",
      };
    });

    const first = scheduler.add(failingTask, { shouldStop: () => false });
    const second = scheduler.add(blockedTask, { shouldStop: () => false });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContain("task-a:429");
    expect(events).not.toContain("task-b:blocked");

    nowMs += 9_000;
    releasePause?.();
    events.push("pause:released");

    await Promise.all([first, second]);
    expect(events.indexOf("task-b:blocked")).toBeGreaterThan(events.indexOf("pause:released"));
    expect(failingTask.mock.calls.length).toBeGreaterThan(1);
  });
});
