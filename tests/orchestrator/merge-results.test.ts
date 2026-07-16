import { describe, expect, it } from "vitest";
import type { DatePair } from "../../src/domain/types.js";
import type { JobError } from "../../src/jobs/types.js";
import type { ProviderId, Quote } from "../../src/providers/types.js";
import {
  mergePair,
  sortResults,
  type CellOutcome,
} from "../../src/orchestrator/merge-results.js";

const pair: DatePair = {
  departureDate: "2026-10-01",
  returnDate: "2026-10-05",
  tripDays: 5,
};
const quote = (price: number, currency = "KRW"): Quote => ({
  price,
  currency,
  url: `https://example.test/${price}`,
  scrapedAt: "2026-07-14T00:00:00.000Z",
});
const success = (source: ProviderId, value: Quote): CellOutcome => ({
  kind: "success",
  source,
  quote: value,
});
const failure = (source: ProviderId): CellOutcome => {
  const error: JobError = {
    departureDate: pair.departureDate,
    returnDate: pair.returnDate,
    source,
    code: "provider_error",
    message: `${source} failed`,
    at: "2026-07-14T00:00:00.000Z",
  };
  return { kind: "failure", source, error };
};
const now = () => "2026-07-14T00:00:01.000Z";

describe("mergePair", () => {
  it("uses Google for an equal-price tie", () => {
    const merged = mergePair(
      pair,
      success("google", quote(100_000)),
      success("naver", quote(100_000)),
      now,
    );
    expect(merged.row?.best.source).toBe("google");
    expect(merged.failed).toBe(false);
    expect([merged.googleOk, merged.naverOk]).toEqual([1, 1]);
  });

  it("keeps a row when only one source succeeds", () => {
    const merged = mergePair(
      pair,
      failure("google"),
      success("naver", quote(90_000)),
      now,
    );
    expect(merged.row?.google).toBeNull();
    expect(merged.row?.best.source).toBe("naver");
    expect(merged.errors).toHaveLength(1);
    expect(merged.failed).toBe(false);
  });

  it("counts both-source failure and omits the row", () => {
    const merged = mergePair(pair, failure("google"), failure("naver"), now);
    expect(merged.row).toBeNull();
    expect(merged.errors).toHaveLength(2);
    expect(merged.failed).toBe(true);
  });

  it("rejects incomparable currencies as a failed pair", () => {
    const merged = mergePair(
      pair,
      success("google", quote(100, "USD")),
      success("naver", quote(130_000, "KRW")),
      now,
    );
    expect(merged.row).toBeNull();
    expect(merged.failed).toBe(true);
    expect(merged.errors.map((error) => error.code)).toEqual([
      "currency_mismatch",
      "currency_mismatch",
    ]);
  });

  it("sorts partial rows by price then dates", () => {
    const a = mergePair(
      pair,
      success("google", quote(120_000)),
      failure("naver"),
      now,
    ).row!;
    const bPair = { ...pair, departureDate: "2026-09-30", returnDate: "2026-10-04" };
    const b = mergePair(
      bPair,
      success("google", quote(100_000)),
      failure("naver"),
      now,
    ).row!;
    expect(sortResults([a, b]).map((row) => row.departureDate)).toEqual([
      "2026-09-30",
      "2026-10-01",
    ]);
  });
});
