/// <reference types="node" />

export interface RuntimeConfig {
  dataDir: string;
  concurrencyPerSource: number;
  minDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  requestTimeoutMs: number;
  naverHeadless: boolean;
}

function parseBooleanFlag(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback = false,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (raw === "1" || raw.toLowerCase() === "true") {
    return true;
  }
  if (raw === "0" || raw.toLowerCase() === "false") {
    return false;
  }
  throw new RangeError(`${key} must be 1, 0, true, or false`);
}

function parseStrictInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new RangeError(`${key} must be a base-10 integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${key} must be a safe integer`);
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  // Live sweep 2026-07-16 (52 pairs x2 sources, zero blocks): 3 -> 140s,
  // 4 -> 100s, 5 -> 80s, 6 -> 80s. 5 is the measured optimum; beyond it the
  // jitter delay and page-load time dominate, so extra parallelism only adds
  // provider block risk (captcha / "unusual traffic").
  const concurrencyPerSource = clamp(
    parseStrictInteger(env, "SEARCH_WAY_PROVIDER_CONCURRENCY", 5),
    1,
    6,
  );
  const minDelayMs = parseStrictInteger(env, "SEARCH_WAY_MIN_DELAY_MS", 500);
  const maxDelayMs = parseStrictInteger(env, "SEARCH_WAY_MAX_DELAY_MS", 1500);
  const maxRetries = clamp(
    parseStrictInteger(env, "SEARCH_WAY_MAX_RETRIES", 3),
    0,
    3,
  );
  const retryBaseDelayMs = parseStrictInteger(
    env,
    "SEARCH_WAY_RETRY_BASE_DELAY_MS",
    1_000,
  );
  const requestTimeoutMs = parseStrictInteger(
    env,
    "SEARCH_WAY_REQUEST_TIMEOUT_MS",
    30_000,
  );
  const dataDir = env.SEARCH_WAY_DATA_DIR ?? "./data/jobs";
  const naverHeadless = parseBooleanFlag(env, "SEARCH_WAY_NAVER_HEADLESS", false);

  if (minDelayMs < 0 || maxDelayMs < 0) {
    throw new RangeError("SEARCH_WAY_MIN_DELAY_MS and SEARCH_WAY_MAX_DELAY_MS must be non-negative");
  }
  if (maxDelayMs < minDelayMs) {
    throw new RangeError("SEARCH_WAY_MAX_DELAY_MS must be greater than or equal to SEARCH_WAY_MIN_DELAY_MS");
  }
  if (retryBaseDelayMs <= 0) {
    throw new RangeError("SEARCH_WAY_RETRY_BASE_DELAY_MS must be positive");
  }
  if (requestTimeoutMs <= 0) {
    throw new RangeError("SEARCH_WAY_REQUEST_TIMEOUT_MS must be positive");
  }

  return {
    dataDir,
    concurrencyPerSource,
    minDelayMs,
    maxDelayMs,
    maxRetries,
    retryBaseDelayMs,
    requestTimeoutMs,
    naverHeadless,
  };
}
