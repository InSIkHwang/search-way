import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  extractGoogleDirectCandidates,
  isGoogleResultsReady,
  parseGoogleDirectRoundTrip,
  GoogleParseFailure,
} from "../../../src/providers/google/parser.js";

interface GoogleFixtureManifest {
  fixtures: Record<string, { file: string }>;
}

export function inspectGoogleFixture(body: string): {
  directRoundTrips: Array<{ stopCount: number; price: number }>;
} {
  return {
    directRoundTrips: extractGoogleDirectCandidates(body).map((candidate) => ({
      stopCount: candidate.stopCount,
      price: candidate.price,
    })),
  };
}

const scrapedAt = "2026-07-14T00:00:00.000Z";
const parseContext = {
  departureDate: "2026-10-08",
  returnDate: "2026-10-12",
};
const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);
const manifest = JSON.parse(
  await readFile(fixtureUrl("manifest.json"), "utf8"),
) as GoogleFixtureManifest;
const fixture = (key: string) =>
  readFile(fixtureUrl(manifest.fixtures[key]!.file), "utf8");

describe("parseGoogleDirectRoundTrip", () => {
  it("parses the recorded final_case provenance fixture", async () => {
    const body = await fixture("provenanceDirectRoundTrip");
    const quote = parseGoogleDirectRoundTrip(body, scrapedAt, undefined, parseContext);

    expect(quote.currency).toBe("KRW");
    expect(quote.price).toBe(417629);
    expect(quote.airline).toBe("Asiana Airlines");
    expect(Number.isSafeInteger(quote.price)).toBe(true);
    expect(new URL(quote.url).protocol).toMatch(/^https?:$/);
    expect(quote.scrapedAt).toBe(scrapedAt);
    expect(quote.outbound).toMatchObject({
      date: "2026-10-08",
      departureTime: "09:30",
      arrivalTime: "12:35",
      airline: "Asiana Airlines",
    });
    expect(quote.inbound).toMatchObject({
      date: "2026-10-12",
      departureTime: "10:15",
      arrivalTime: "12:20",
      airline: "Asiana Airlines",
    });
  });

  it("parses the modern Google row layout with aria-label airline and price", () => {
    const body = `<!DOCTYPE html><html><head><meta name="capture-url" content="https://www.google.com/travel/flights/search?q=test" /></head><body><ul><li class="pIav2d"><div aria-label="왕복 총 가격은 최저 561808 대한민국 원입니다. 비엣젯항공의 직항 항공편입니다.">row</div><span>직항</span><span>₩561,808</span></li></ul></body></html>`;
    const quote = parseGoogleDirectRoundTrip(body, scrapedAt);

    expect(quote.price).toBe(561808);
    expect(quote.airline).toBe("비엣젯항공");
    expect(quote.url).toContain("google.com/travel/flights/search");
  });

  it("detects ready state only when a direct KRW row exists", () => {
    expect(isGoogleResultsReady(`<html><body><li class="pIav2d"><span class="VG3hNb">직항</span><span aria-label="417629 대한민국 원">₩417,629</span></li></body></html>`)).toBe(true);
    expect(isGoogleResultsReady(`<html><body><li class="pIav2d"><span class="VG3hNb">1회 경유</span><span aria-label="350000 대한민국 원">₩350,000</span></li></body></html>`)).toBe(false);
  });

  it("selects the minimum from synthetic direct candidates", async () => {
    const body = await fixture("syntheticMultipleDirect");
    const evidence = inspectGoogleFixture(body);
    const quote = parseGoogleDirectRoundTrip(body, scrapedAt);

    expect(evidence.directRoundTrips.length).toBeGreaterThanOrEqual(2);
    expect(evidence.directRoundTrips.every((item) => item.stopCount === 0)).toBe(true);
    expect(quote.price).toBe(
      Math.min(...evidence.directRoundTrips.map((item) => item.price)),
    );
  });

  it("omits airline for the synthetic optional-airline edge", async () => {
    const body = await fixture("syntheticWithoutAirline");
    const quote = parseGoogleDirectRoundTrip(body, scrapedAt);

    expect("airline" in quote).toBe(false);
  });

  it("rejects a normal response with no direct flight", async () => {
    const body = await fixture("noDirectFlight");

    expect(() => parseGoogleDirectRoundTrip(body, scrapedAt)).toThrowError(
      expect.objectContaining<Partial<GoogleParseFailure>>({
        code: "no_direct_flight",
      }),
    );
  });

  it("rejects malformed source responses", async () => {
    const body = await fixture("malformedResponse");

    expect(() => parseGoogleDirectRoundTrip(body, scrapedAt)).toThrowError(
      expect.objectContaining<Partial<GoogleParseFailure>>({
        code: "provider_error",
      }),
    );
  });

  it("rejects a non-ISO scrapedAt value", async () => {
    const body = await fixture("provenanceDirectRoundTrip");

    expect(() =>
      parseGoogleDirectRoundTrip(body, "2026-07-14"),
    ).toThrowError(
      expect.objectContaining<Partial<GoogleParseFailure>>({
        code: "provider_error",
      }),
    );
  });
});
