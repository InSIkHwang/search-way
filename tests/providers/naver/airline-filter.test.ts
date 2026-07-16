import { describe, expect, it } from "vitest";
import { parseNaverDirectRoundTrip } from "../../../src/providers/naver/parser.js";

const scrapedAt = "2026-07-16T00:00:00.000Z";

function wrapBody(lines: string[]): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8" />' +
    '<meta name="capture-url" content="https://flight.naver.com/flights/international/x" />' +
    '</head><body><pre id="body-text">' +
    lines.join("\n") +
    "</pre></body></html>"
  );
}

const multiAirlineBody = wrapBody([
  "비엣젯항공",
  "직항",
  "왕복",
  "350,000",
  "원",
  "베트남항공",
  "직항",
  "왕복",
  "420,000",
  "원",
  "베트남항공",
  "직항",
  "왕복",
  "450,000",
  "원",
]);

describe("parseNaverDirectRoundTrip airline filter", () => {
  it("still returns the overall lowest candidate without a filter", () => {
    const quote = parseNaverDirectRoundTrip(multiAirlineBody, scrapedAt);
    expect(quote.price).toBe(350_000);
    expect(quote.airline).toBe("비엣젯항공");
  });

  it("returns the lowest candidate of the requested airline", () => {
    const quote = parseNaverDirectRoundTrip(multiAirlineBody, scrapedAt, "베트남항공");
    expect(quote.price).toBe(420_000);
    expect(quote.airline).toBe("베트남항공");
  });

  it("throws no_direct_flight when no candidate matches the airline", () => {
    expect(() =>
      parseNaverDirectRoundTrip(multiAirlineBody, scrapedAt, "대한항공"),
    ).toThrow(expect.objectContaining({ code: "no_direct_flight" }));
  });
});
