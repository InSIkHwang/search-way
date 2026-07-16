import type { ProviderId, Quote } from "../providers/types.js";
import { classifyProviderError } from "./error-taxonomy.js";
import type { RetryPolicy, SourceLimiterHooks } from "./config.js";

export interface ExecutionToken {
  shouldStop(): boolean;
}

export interface SourceSchedulerOptions {
  source: ProviderId;
  concurrency: number;
  minDelayMs: number;
  maxDelayMs: number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => string;
  retryBaseDelayMs: number;
  retryPolicy: RetryPolicy;
  limiterHooks: SourceLimiterHooks;
}

export type QueueOutcome =
  | { kind: "success"; source: ProviderId; quote: Quote }
  | { kind: "failure"; source: ProviderId; cause: unknown }
  | { kind: "cancelled"; source: ProviderId };

interface QueueTask {
  task: () => Promise<Quote>;
  token: ExecutionToken;
  resolve: (outcome: QueueOutcome) => void;
}

export class SourceScheduler {
  private readonly queue: QueueTask[] = [];
  private active = 0;
  private pausedUntil = Number.NEGATIVE_INFINITY;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly options: SourceSchedulerOptions) {}

  add(task: () => Promise<Quote>, token: ExecutionToken): Promise<QueueOutcome> {
    return new Promise<QueueOutcome>((resolve) => {
      this.queue.push({ task, token, resolve });
      this.drain();
    });
  }

  onIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private drain(): void {
    while (this.active < this.options.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) {
        return;
      }
      this.active += 1;
      void this.run(item).finally(() => {
        this.active -= 1;
        this.drain();
        this.notifyIdleIfNeeded();
      });
    }
  }

  private notifyIdleIfNeeded(): void {
    if (this.active === 0 && this.queue.length === 0) {
      const waiters = this.idleWaiters.splice(0);
      for (const waiter of waiters) {
        waiter();
      }
    }
  }

  private jitterDelay(): number {
    const { minDelayMs, maxDelayMs, random } = this.options;
    if (maxDelayMs === minDelayMs) {
      return minDelayMs;
    }
    return Math.floor(minDelayMs + random() * (maxDelayMs - minDelayMs + 1));
  }

  private async waitForPause(): Promise<void> {
    const nowMs = Date.parse(this.options.now());
    const waitMs = Math.max(0, this.pausedUntil - nowMs);
    if (waitMs > 0) {
      await this.options.sleep(waitMs);
    }
  }

  private async run(item: QueueTask): Promise<void> {
    const { source, sleep, limiterHooks, retryPolicy } = this.options;

    if (item.token.shouldStop()) {
      item.resolve({ kind: "cancelled", source });
      return;
    }

    const delay = this.jitterDelay();
    if (delay > 0) {
      await sleep(delay);
    }
    if (item.token.shouldStop()) {
      item.resolve({ kind: "cancelled", source });
      return;
    }

    await this.waitForPause();
    if (item.token.shouldStop()) {
      item.resolve({ kind: "cancelled", source });
      return;
    }

    await limiterHooks.beforeAttempt(source);
    if (item.token.shouldStop()) {
      item.resolve({ kind: "cancelled", source });
      return;
    }

    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
      if (item.token.shouldStop()) {
        item.resolve({ kind: "cancelled", source });
        return;
      }

      await this.waitForPause();
      if (item.token.shouldStop()) {
        item.resolve({ kind: "cancelled", source });
        return;
      }

      try {
        const quote = await item.task();
        item.resolve({ kind: "success", source, quote });
        return;
      } catch (error) {
        await limiterHooks.afterFailure(source, error);
        if (attempt < retryPolicy.maxAttempts && retryPolicy.shouldRetry(error, attempt)) {
          const classified = classifyProviderError(error, Date.parse(this.options.now()));
          const retryNumber = attempt;
          const exponentialMs =
            this.options.retryBaseDelayMs * 2 ** (retryNumber - 1);
          const jitteredMs = Math.round(exponentialMs * (0.5 + this.options.random()));
          const delayMs = Math.max(jitteredMs, classified.retryAfterMs ?? 0);

          if (classified.code === "provider_blocked" && classified.transient) {
            const nowMs = Date.parse(this.options.now());
            this.pausedUntil = Math.max(
              this.pausedUntil,
              nowMs + Math.max(jitteredMs, classified.retryAfterMs ?? 0),
            );
          } else {
            await sleep(delayMs);
          }

          if (item.token.shouldStop()) {
            item.resolve({ kind: "cancelled", source });
            return;
          }
          continue;
        }
        item.resolve({ kind: "failure", source, cause: error });
        return;
      }
    }
  }
}
