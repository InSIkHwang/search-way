import type { JobErrorCode } from "../jobs/types.js";

export interface ClassifiedProviderError {
  code: JobErrorCode;
  message: string;
  transient: boolean;
  retryAfterMs?: number;
}

type RawError = {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  retryAfter?: unknown;
  retryAfterMs?: unknown;
  cause?: unknown;
};

function asRaw(error: unknown): RawError {
  return typeof error === "object" && error !== null ? (error as RawError) : {};
}

function parseRetryAfter(raw: RawError, nowMs: number): number | undefined {
  if (typeof raw.retryAfterMs === "number" && raw.retryAfterMs > 0) {
    return raw.retryAfterMs;
  }
  if (typeof raw.retryAfter !== "string") {
    return undefined;
  }
  if (/^\d+$/.test(raw.retryAfter)) {
    return Number(raw.retryAfter) * 1_000;
  }
  const dateMs = Date.parse(raw.retryAfter);
  const delayMs = dateMs - nowMs;
  return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined;
}

const providerCodes = new Set([
  "provider_timeout",
  "provider_blocked",
  "no_direct_flight",
  "provider_error",
]);

export function classifyProviderError(
  error: unknown,
  nowMs: number,
): ClassifiedProviderError {
  const raw = asRaw(error);
  const cause = asRaw(raw.cause);
  const sourceCode = providerCodes.has(String(raw.code)) ? String(raw.code) : undefined;
  const status =
    typeof raw.status === "number"
      ? raw.status
      : typeof raw.statusCode === "number"
        ? raw.statusCode
        : typeof cause.status === "number"
          ? cause.status
          : cause.statusCode;
  const signalCode = sourceCode === undefined ? raw.code : cause.code;
  const retryAfterMs = parseRetryAfter(raw, nowMs) ?? parseRetryAfter(cause, nowMs);

  if (sourceCode === "provider_timeout") {
    return { code: "provider_timeout", transient: true, message: "Provider request timed out" };
  }
  if (sourceCode === "provider_blocked" && status === 429) {
    return {
      code: "provider_blocked",
      transient: true,
      message: "Provider rate limit reached",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (sourceCode === "provider_blocked") {
    return { code: "provider_blocked", transient: false, message: "Provider blocked the request" };
  }
  if (sourceCode === "no_direct_flight") {
    return {
      code: "no_direct_flight",
      transient: false,
      message: "No direct round-trip flight found",
    };
  }
  if (sourceCode === "provider_error" && [500, 502, 503, 504].includes(Number(status))) {
    return {
      code: "provider_error",
      transient: true,
      message: "Provider service temporarily unavailable",
    };
  }
  if (
    sourceCode === "provider_error" &&
    ["ECONNRESET", "EAI_AGAIN", "ENETUNREACH"].includes(String(signalCode))
  ) {
    return { code: "provider_error", transient: true, message: "Provider network request failed" };
  }
  if (sourceCode === "provider_error") {
    return {
      code: "provider_error",
      transient: false,
      message: "Provider response could not be processed",
    };
  }
  if (
    raw.name === "AbortError" ||
    raw.name === "TimeoutError" ||
    signalCode === "ETIMEDOUT"
  ) {
    return {
      code: "provider_timeout",
      transient: true,
      message: "Provider request timed out",
    };
  }
  if (status === 429) {
    return {
      code: "provider_blocked",
      transient: true,
      message: "Provider rate limit reached",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (status === 403) {
    return { code: "provider_blocked", transient: false, message: "Provider blocked the request" };
  }
  if ([500, 502, 503, 504].includes(Number(status))) {
    return {
      code: "provider_error",
      transient: true,
      message: "Provider service temporarily unavailable",
    };
  }
  if (["ECONNRESET", "EAI_AGAIN", "ENETUNREACH"].includes(String(signalCode))) {
    return { code: "provider_error", transient: true, message: "Provider network request failed" };
  }
  return {
    code: "provider_error",
    transient: false,
    message: "Provider response could not be processed",
  };
}
