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
  // Live sweep 2026-07-16, wall time for 52 pairs x2 sources, zero blocks
  // at every level: 3 -> 125s, 4 -> 96s, 5 -> 77s, 6 -> 61s, 8 -> 59s,
  // 10 -> 69s. 6 and 8 tie within noise; 6 keeps fewer concurrent pages
  // against each site, so it wins on block risk (captcha / "unusual
  // traffic"). Past that the floor is provider server response time.
  const concurrencyPerSource = clamp(
    parseStrictInteger(env, "SEARCH_WAY_PROVIDER_CONCURRENCY", 6),
    1,
    10,
  );
  // 100-300ms staggers request starts; measured vs 500-1500ms it saves a
  // few seconds per run and showed no block-rate difference.
  const minDelayMs = parseStrictInteger(env, "SEARCH_WAY_MIN_DELAY_MS", 100);
  const maxDelayMs = parseStrictInteger(env, "SEARCH_WAY_MAX_DELAY_MS", 300);
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
