import type { DatePair, FlexibleSearchRequest } from "../domain/types.js";
import { JobNotFoundError, JobStoreError, JsonJobStore } from "../jobs/store.js";
import type { JobError, SearchJob } from "../jobs/types.js";
import type { FlightProvider, ProviderId } from "../providers/types.js";
import {
  createOrchestratorConfig,
  type OrchestratorConfigOverrides,
} from "./config.js";
import { classifyProviderError } from "./error-taxonomy.js";
import { mergePair, sortResults, type CellOutcome } from "./merge-results.js";
import { SourceScheduler, type QueueOutcome } from "./queue.js";

export interface StartSearchResult {
  jobId: string;
  totalPairs: number;
  status: "queued";
}

export interface SearchOrchestrator {
  recoverInterrupted(): Promise<number>;
  start(request: FlexibleSearchRequest): Promise<StartSearchResult>;
  getStatus(jobId: string): Promise<SearchJob>;
  cancel(jobId: string): Promise<SearchJob>;
  waitForIdle(jobId: string): Promise<void>;
  releaseRuntime(jobId: string): boolean;
}

export interface SourceSchedulers {
  google: SourceScheduler;
  naver: SourceScheduler;
}

export interface OrchestratorDependencies {
  google: FlightProvider;
  naver: FlightProvider;
  store: JsonJobStore;
  generateDatePairs: (request: FlexibleSearchRequest) => DatePair[];
  createJobId: () => string;
  config?: OrchestratorConfigOverrides;
  schedulers?: SourceSchedulers;
}

interface Runtime {
  cancellationRequested: boolean;
  fatal: unknown | null;
  run: Promise<void>;
  settled: boolean;
  settledAt: number | null;
}

export function createSearchOrchestrator(
  dependencies: OrchestratorDependencies,
): SearchOrchestrator {
  if (dependencies.google.id !== "google") {
    throw new Error("google provider id must be google");
  }
  if (dependencies.naver.id !== "naver") {
    throw new Error("naver provider id must be naver");
  }

  const config = createOrchestratorConfig(dependencies.config);
  const runtimes = new Map<string, Runtime>();

  const makeScheduler = (source: ProviderId) =>
    new SourceScheduler({
      source,
      concurrency: config.concurrencyPerSource,
      minDelayMs: config.minDelayMs,
      maxDelayMs: config.maxDelayMs,
      random: config.random,
      sleep: config.sleep,
      now: config.now,
      retryBaseDelayMs: config.retryBaseDelayMs,
      retryPolicy: config.retryPolicy,
      limiterHooks: config.limiterHooks,
    });

  const schedulers = dependencies.schedulers ?? {
    google: makeScheduler("google"),
    naver: makeScheduler("naver"),
  };

  async function persist<T>(runtime: Runtime, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      runtime.cancellationRequested = true;
      if (runtime.fatal === null) {
        runtime.fatal = error;
      }
      throw error;
    }
  }

  function pruneSettledRuntimes(): void {
    const settled = [...runtimes.entries()]
      .filter(([, runtime]) => runtime.settled)
      .sort((left, right) => (left[1].settledAt ?? 0) - (right[1].settledAt ?? 0));
    while (settled.length > config.settledRuntimeLimit) {
      const [jobId] = settled.shift()!;
      runtimes.delete(jobId);
    }
  }

  function queueOutcomeToCell(
    outcome: QueueOutcome,
    pair: DatePair,
    now: string,
  ): CellOutcome {
    if (outcome.kind === "success") {
      return { kind: "success", source: outcome.source, quote: outcome.quote };
    }
    if (outcome.kind === "cancelled") {
      return { kind: "cancelled", source: outcome.source };
    }
    const classified = classifyProviderError(outcome.cause, Date.parse(now));
    const error: JobError = {
      departureDate: pair.departureDate,
      returnDate: pair.returnDate,
      source: outcome.source,
      code: classified.code,
      message: classified.message,
      at: now,
    };
    return { kind: "failure", source: outcome.source, error };
  }

  async function execute(
    runtime: Runtime,
    jobId: string,
    pairs: DatePair[],
    request: FlexibleSearchRequest,
  ): Promise<void> {
    try {
      await persist(runtime, () =>
        dependencies.store.update(jobId, (current) =>
          current.status === "queued"
            ? { ...current, status: "running", updatedAt: config.now() }
            : current,
        ),
      );

      if (runtime.cancellationRequested || runtime.fatal !== null) {
        return;
      }

      const token = {
        shouldStop: () => runtime.cancellationRequested || runtime.fatal !== null,
      };

      const pairPromises = pairs.map(async (pair) => {
        const input = {
          ...pair,
          origin: request.origin,
          destination: request.destination,
          ...(request.airline === undefined ? {} : { airline: request.airline }),
        };
        const [googleOutcome, naverOutcome] = await Promise.all([
          schedulers.google.add(() => dependencies.google.findDirectRoundTrip(input), token),
          schedulers.naver.add(() => dependencies.naver.findDirectRoundTrip(input), token),
        ]);

        const googleCell = queueOutcomeToCell(googleOutcome, pair, config.now());
        const naverCell = queueOutcomeToCell(naverOutcome, pair, config.now());

        if (googleCell.kind === "cancelled" || naverCell.kind === "cancelled") {
          return;
        }

        const merged = mergePair(pair, googleCell, naverCell, config.now);

        await persist(runtime, () =>
          dependencies.store.update(jobId, (current) => {
            if (current.status === "failed" || current.status === "completed") {
              return current;
            }
            return {
              ...current,
              updatedAt: config.now(),
              progress: {
                ...current.progress,
                completedPairs: current.progress.completedPairs + 1,
                failedPairs: current.progress.failedPairs + (merged.failed ? 1 : 0),
                googleOk: current.progress.googleOk + merged.googleOk,
                naverOk: current.progress.naverOk + merged.naverOk,
              },
              results: sortResults(
                merged.row ? [...current.results, merged.row] : current.results,
              ),
              errors: [...current.errors, ...merged.errors],
            };
          }),
        );
      });

      await Promise.all(pairPromises);

      await persist(runtime, () =>
        dependencies.store.update(jobId, (current) => {
          if (
            current.status === "failed" ||
            current.status === "completed" ||
            current.status === "cancelled"
          ) {
            return current;
          }
          return {
            ...current,
            status: "completed",
            updatedAt: config.now(),
          };
        }),
      );
    } catch (runtimeError) {
      try {
        await dependencies.store.update(jobId, (current) => {
          if (current.status === "completed" || current.status === "cancelled") {
            return current;
          }
          return {
            ...current,
            status: "failed",
            failureReason: "store_error",
            updatedAt: config.now(),
          };
        });
      } catch (persistenceError) {
        throw new AggregateError(
          [runtimeError, persistenceError],
          "Search job failed and failure status could not be persisted",
        );
      }
      throw runtimeError;
    }
  }

  return {
    recoverInterrupted: () => dependencies.store.markInterrupted(),

    async start(request: FlexibleSearchRequest): Promise<StartSearchResult> {
      const pairs = dependencies.generateDatePairs(request);
      const jobId = dependencies.createJobId();
      const timestamp = config.now();
      const job: SearchJob = {
        jobId,
        status: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
        request,
        progress: {
          totalPairs: pairs.length,
          completedPairs: 0,
          failedPairs: 0,
          googleOk: 0,
          naverOk: 0,
        },
        results: [],
        errors: [],
        cancellationRequested: false,
      };

      await dependencies.store.create(job);

      const runtime: Runtime = {
        cancellationRequested: false,
        fatal: null,
        run: Promise.resolve(),
        settled: false,
        settledAt: null,
      };

      runtime.run = Promise.resolve().then(() =>
        execute(runtime, jobId, pairs, request),
      );
      void runtime.run.catch(() => undefined);
      void runtime.run
        .finally(() => {
          runtime.settled = true;
          runtime.settledAt = Date.now();
          pruneSettledRuntimes();
        })
        .catch(() => undefined);

      runtimes.set(jobId, runtime);

      return {
        jobId,
        totalPairs: pairs.length,
        status: "queued",
      };
    },

    getStatus: (jobId: string) => dependencies.store.get(jobId),

    async cancel(jobId: string): Promise<SearchJob> {
      const runtime = runtimes.get(jobId);
      if (runtime) {
        runtime.cancellationRequested = true;
      }
      return dependencies.store.update(jobId, (current) => {
        if (
          current.status === "completed" ||
          current.status === "failed" ||
          current.status === "cancelled"
        ) {
          return current;
        }
        return {
          ...current,
          status: "cancelled",
          cancellationRequested: true,
          updatedAt: config.now(),
        };
      });
    },

    async waitForIdle(jobId: string): Promise<void> {
      const runtime = runtimes.get(jobId);
      if (runtime) {
        await runtime.run;
        return;
      }
      let snapshot: SearchJob;
      try {
        snapshot = await dependencies.store.get(jobId);
      } catch (error) {
        if (error instanceof JobNotFoundError) {
          throw error;
        }
        throw error;
      }
      if (snapshot.status === "queued" || snapshot.status === "running") {
        throw new Error(`Runtime missing for active job ${jobId}`);
      }
    },

    releaseRuntime(jobId: string): boolean {
      const runtime = runtimes.get(jobId);
      if (!runtime || !runtime.settled) {
        return false;
      }
      runtimes.delete(jobId);
      return true;
    },
  };
}
