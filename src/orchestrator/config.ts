import type { ProviderId } from "../providers/types.js";
import { classifyProviderError } from "./error-taxonomy.js";

export interface RetryPolicy {
  maxAttempts: number;
  shouldRetry(error: unknown, attempt: number): boolean;
}

export interface SourceLimiterHooks {
  beforeAttempt(source: ProviderId): Promise<void>;
  afterFailure(source: ProviderId, error: unknown): Promise<void>;
}

export interface OrchestratorConfig {
  concurrencyPerSource: number;
  minDelayMs: number;
  maxDelayMs: number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => string;
  retryBaseDelayMs: number;
  retryPolicy: RetryPolicy;
  limiterHooks: SourceLimiterHooks;
  settledRuntimeLimit: number;
}

export type OrchestratorConfigOverrides = Partial<
  Omit<OrchestratorConfig, "retryPolicy" | "limiterHooks">
> & {
  retryPolicy?: Partial<RetryPolicy>;
  limiterHooks?: Partial<SourceLimiterHooks>;
};

const defaults: OrchestratorConfig = {
  concurrencyPerSource: 2,
  minDelayMs: 500,
  maxDelayMs: 1500,
  random: Math.random,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => new Date().toISOString(),
  retryBaseDelayMs: 1_000,
  retryPolicy: {
    maxAttempts: 4,
    shouldRetry: (error, attempt) =>
      attempt < 4 && classifyProviderError(error, 0).transient,
  },
  limiterHooks: {
    beforeAttempt: async () => undefined,
    afterFailure: async () => undefined,
  },
  settledRuntimeLimit: 100,
};

export function createOrchestratorConfig(
  overrides: OrchestratorConfigOverrides = {},
): OrchestratorConfig {
  const config: OrchestratorConfig = {
    ...defaults,
    ...overrides,
    retryPolicy: { ...defaults.retryPolicy, ...overrides.retryPolicy },
    limiterHooks: { ...defaults.limiterHooks, ...overrides.limiterHooks },
  };

  if (!Number.isInteger(config.concurrencyPerSource) || config.concurrencyPerSource < 1) {
    throw new RangeError("concurrencyPerSource must be a positive integer");
  }
  if (!Number.isFinite(config.minDelayMs) || config.minDelayMs < 0) {
    throw new RangeError("minDelayMs must be non-negative");
  }
  if (!Number.isFinite(config.maxDelayMs) || config.maxDelayMs < config.minDelayMs) {
    throw new RangeError("maxDelayMs must be greater than or equal to minDelayMs");
  }
  if (!Number.isFinite(config.retryBaseDelayMs) || config.retryBaseDelayMs <= 0) {
    throw new RangeError("retryBaseDelayMs must be positive");
  }
  if (!Number.isInteger(config.retryPolicy.maxAttempts) || config.retryPolicy.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  if (!Number.isInteger(config.settledRuntimeLimit) || config.settledRuntimeLimit < 1) {
    throw new RangeError("settledRuntimeLimit must be a positive integer");
  }
  return config;
}
