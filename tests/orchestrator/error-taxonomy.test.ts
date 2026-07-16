import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../../src/orchestrator/error-taxonomy.js";

const NOW = Date.parse("2026-07-14T00:00:00.000Z");

describe("classifyProviderError", () => {
  it.each([
    [{ code: "provider_timeout" }, "provider_timeout", true, "Provider request timed out"],
    [{ code: "provider_blocked", status: 429, retryAfter: "7" }, "provider_blocked", true, "Provider rate limit reached"],
    [{ code: "provider_blocked", status: 403 }, "provider_blocked", false, "Provider blocked the request"],
    [{ code: "provider_blocked" }, "provider_blocked", false, "Provider blocked the request"],
    [{ code: "no_direct_flight" }, "no_direct_flight", false, "No direct round-trip flight found"],
    [{ code: "no_direct_flight", name: "TimeoutError" }, "no_direct_flight", false, "No direct round-trip flight found"],
    [{ code: "provider_error", cause: { status: 503 } }, "provider_error", true, "Provider service temporarily unavailable"],
    [{ code: "provider_error", cause: { code: "ECONNRESET" } }, "provider_error", true, "Provider network request failed"],
    [{ code: "provider_error" }, "provider_error", false, "Provider response could not be processed"],
    [{ name: "TimeoutError" }, "provider_timeout", true, "Provider request timed out"],
  ] as const)("maps %# without extending JobErrorCode", (raw, code, transient, message) => {
    expect(classifyProviderError(raw, NOW)).toMatchObject({ code, transient, message });
  });

  it("parses Retry-After seconds", () => {
    expect(
      classifyProviderError(
        { code: "provider_blocked", status: 429, retryAfter: "7" },
        NOW,
      ).retryAfterMs,
    ).toBe(7_000);
  });

  it("parses Retry-After HTTP-date relative to injected now", () => {
    expect(
      classifyProviderError(
        {
          code: "provider_blocked",
          status: 429,
          retryAfter: "Tue, 14 Jul 2026 00:00:09 GMT",
        },
        NOW,
      ).retryAfterMs,
    ).toBe(9_000);
  });

  it("clamps an expired or invalid Retry-After to undefined", () => {
    expect(
      classifyProviderError(
        { code: "provider_blocked", status: 429, retryAfter: "invalid" },
        NOW,
      ).retryAfterMs,
    ).toBeUndefined();
    expect(
      classifyProviderError(
        {
          code: "provider_blocked",
          status: 429,
          retryAfter: "Mon, 13 Jul 2026 23:59:59 GMT",
        },
        NOW,
      ).retryAfterMs,
    ).toBeUndefined();
  });
});
