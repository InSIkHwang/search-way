import type { ProviderId, Quote } from "../providers/types.js";
import { classifyProviderError } from "./error-taxonomy.js";
import type { RetryPolicy, SourceLimiterHooks } from "./config.js";

export interface ExecutionToken {
  shouldStop(): boolean;
  /**
   * When provided, aborting this signal force-cancels in-flight tasks: the
   * scheduler aborts the per-attempt signal it handed to the task and returns
   * the concurrency slot instead of waiting for the task to settle on its own.
   */
  signal?: AbortSignal;
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
  /**
   * Hard per-attempt deadline. When it expires the per-attempt signal is
   * aborted; if the task still does not settle within taskKillGraceMs the
   * attempt is failed as a timeout and the slot is reclaimed anyway, so a
   * hung task can never pin a concurrency slot forever. Undefined disables
   * the deadline (legacy behaviour, used by unit tests).
   */
  taskDeadlineMs?: number;
  taskKillGraceMs?: number;
  /** Real-time timers for the deadline; injectable for tests. */
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export type QueueOutcome =
  | { kind: "success"; source: ProviderId; quote: Quote }
  | { kind: "failure"; source: ProviderId; cause: unknown }
  | { kind: "cancelled"; source: ProviderId };

interface QueueTask {
  task: (signal: AbortSignal) => Promise<Quote>;
  token: ExecutionToken;
  resolve: (outcome: QueueOutcome) => void;
}

const DEFAULT_TASK_KILL_GRACE_MS = 10_000;

/** Internal control-flow marker: the token aborted while the task ran. */
class TaskCancelledError extends Error {
  constructor() {
    super("Task cancelled");
  }
}

type SettledTask =
  | { ok: true; quote: Quote }
  | { ok: false; cause: unknown };

export class SourceScheduler {
  private readonly queue: QueueTask[] = [];
  private active = 0;
  private pausedUntil = Number.NEGATIVE_INFINITY;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly options: SourceSchedulerOptions) {}

  add(
    task: (signal: AbortSignal) => Promise<Quote>,
    token: ExecutionToken,
  ): Promise<QueueOutcome> {
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

  /**
   * Runs one task attempt with three exits, all of which release the slot:
   * the task settles on its own; the hard deadline aborts it (and, past the
   * kill grace, abandons it as a timeout failure); or the token's signal
   * aborts it because the job was cancelled.
   */
  private async attemptTask(item: QueueTask): Promise<Quote> {
    const setTimer = this.options.setTimeout ?? globalThis.setTimeout;
    const clearTimer = this.options.clearTimeout ?? globalThis.clearTimeout;
    const tokenSignal = item.token.signal;
    if (tokenSignal?.aborted === true) {
      throw new TaskCancelledError();
    }

    const controller = new AbortController();
    const settled: Promise<SettledTask> = Promise.resolve()
      .then(() => item.task(controller.signal))
      .then(
        (quote) => ({ ok: true, quote }),
        (cause) => ({ ok: false, cause }),
      );

    const waitForSettle = (limitMs: number | undefined) =>
      limitMs === undefined
        ? settled
        : new Promise<SettledTask | "deadline">((resolve) => {
            const timer = setTimer(() => resolve("deadline"), limitMs);
            void settled.then((result) => {
              clearTimer(timer);
              resolve(result);
            });
          });

    let onTokenAbort: (() => void) | undefined;
    const cancelled = new Promise<"cancelled">((resolve) => {
      if (tokenSignal === undefined) {
        return;
      }
      onTokenAbort = () => resolve("cancelled");
      tokenSignal.addEventListener("abort", onTokenAbort, { once: true });
    });

    try {
      const first = await Promise.race([
        waitForSettle(this.options.taskDeadlineMs),
        cancelled,
      ]);

      if (first === "cancelled") {
        controller.abort();
        // Give the in-flight task the kill grace to settle: work that was
        // about to finish is preserved as a partial result, while a hung
        // task is abandoned and its slot reclaimed.
        const graced = await waitForSettle(
          this.options.taskKillGraceMs ?? DEFAULT_TASK_KILL_GRACE_MS,
        );
        if (graced !== "deadline" && graced.ok) {
          return graced.quote;
        }
        throw new TaskCancelledError();
      }
      if (first === "deadline") {
        controller.abort();
        const graced = await waitForSettle(
          this.options.taskKillGraceMs ?? DEFAULT_TASK_KILL_GRACE_MS,
        );
        if (graced === "deadline") {
          // The task ignored the abort. Abandon it: the slot is reclaimed and
          // the zombie promise already has handlers attached via `settled`.
          throw Object.assign(
            new Error(
              `${this.options.source} task exceeded the hard deadline and ignored abort`,
            ),
            { name: "TimeoutError" },
          );
        }
        if (graced.ok) {
          return graced.quote;
        }
        throw graced.cause;
      }
      if (first.ok) {
        return first.quote;
      }
      throw first.cause;
    } finally {
      if (tokenSignal !== undefined && onTokenAbort !== undefined) {
        tokenSignal.removeEventListener("abort", onTokenAbort);
      }
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
        const quote = await this.attemptTask(item);
        item.resolve({ kind: "success", source, quote });
        return;
      } catch (error) {
        if (error instanceof TaskCancelledError) {
          item.resolve({ kind: "cancelled", source });
          return;
        }
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
