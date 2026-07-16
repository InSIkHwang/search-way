import { describe, expect, it } from "vitest";
import { parseGoogleDirectRoundTrip } from "../../../src/providers/google/parser.js";

const scrapedAt = "2026-07-16T00:00:00.000Z";

function row(price: string, airline: string): string {
  return (
    '<li class="pIav2d"><div aria-label="왕복 총액 ' +
    price +
    ' 대한민국 원"><span class="VG3hNb">직항</span><span class="airline">' +
    airline +
    "</span></div></li>"
  );
}

const multiAirlineHtml =
  '<!DOCTYPE html><html><head><meta name="capture-url" content="https://www.google.com/travel/flights/search?q=x" /></head><body><ul>' +
  row("350,000", "비엣젯항공") +
  row("420,000", "베트남항공") +
  row("450,000", "베트남항공") +
  "</ul></body></html>";

describe("parseGoogleDirectRoundTrip airline filter", () => {
  it("still returns the overall lowest candidate without a filter", () => {
    const quote = parseGoogleDirectRoundTrip(multiAirlineHtml, scrapedAt);
    expect(quote.price).toBe(350_000);
    expect(quote.airline).toBe("비엣젯항공");
  });

  it("returns the lowest candidate of the requested airline", () => {
    const quote = parseGoogleDirectRoundTrip(multiAirlineHtml, scrapedAt, "베트남항공");
    expect(quote.price).toBe(420_000);
    expect(quote.airline).toBe("베트남항공");
  });

  it("throws no_direct_flight when no candidate matches the airline", () => {
    expect(() =>
      parseGoogleDirectRoundTrip(multiAirlineHtml, scrapedAt, "대한항공"),
    ).toThrow(expect.objectContaining({ code: "no_direct_flight" }));
  });
});
