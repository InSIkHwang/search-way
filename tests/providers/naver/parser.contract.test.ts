import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseNaverDirectRoundTrip,
  NaverParseFailure,
} from "../../../src/providers/naver/parser.js";

interface NaverFixtureManifest {
  fixtures: Record<string, { file: string }>;
}

export function inspectNaverFixture(body: string): {
  directRoundTrips: Array<{ price: number }>;
} {
  const preMatch = body.match(/<pre\s+id=["']body-text["'][^>]*>([\s\S]*?)<\/pre>/i);
  const bodyText = preMatch?.[1]?.trim() ?? "";
  const lines = bodyText.split(/\r?\n/);
  const directRoundTrips: Array<{ price: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1] ?? "";
    const suffixLine = lines[index + 2] ?? "";
    if (
      line !== "왕복" ||
      !/^\d[\d,]*$/.test(nextLine) ||
      !suffixLine.startsWith("원")
    ) {
      continue;
    }
    const context = lines.slice(Math.max(0, index - 8), index).join(" ");
    if (!context.includes("직항")) {
      continue;
    }
    directRoundTrips.push({
      price: Number.parseInt(nextLine.replace(/,/g, ""), 10),
    });
  }

  return { directRoundTrips };
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
) as NaverFixtureManifest;
const fixture = (key: string) =>
  readFile(fixtureUrl(manifest.fixtures[key]!.file), "utf8");

describe("parseNaverDirectRoundTrip", () => {
  it("parses the recorded final_case provenance fixture", async () => {
    const body = await fixture("provenanceDirectRoundTrip");
    const quote = parseNaverDirectRoundTrip(body, scrapedAt, undefined, parseContext);

    expect(quote.currency).toBe("KRW");
    expect(quote.price).toBe(367388);
    expect(Number.isSafeInteger(quote.price)).toBe(true);
    expect(new URL(quote.url).protocol).toMatch(/^https?:$/);
    expect(quote.scrapedAt).toBe(scrapedAt);
    expect(quote.airline).toBe("아시아나항공");
    expect(quote.outbound).toMatchObject({
      date: "2026-10-08",
      departureTime: "09:30",
      arrivalTime: "12:35",
      airline: "아시아나항공",
    });
    expect(quote.inbound).toMatchObject({
      date: "2026-10-12",
      departureTime: "10:15",
      arrivalTime: "12:20",
      airline: "아시아나항공",
    });
  });

  it("extracts airline names from Naver direct rows", () => {
    const body = `<!DOCTYPE html><html><head><meta name="capture-url" content="https://flight.naver.com/flights/international/PUS:airport-SGN:airport-20261205/SGN:airport-PUS:airport-20261213?adult=1&amp;isDirect=true&amp;fareType=Y" /></head><body><pre id="body-text">직항
비엣젯항공
08:00PUS
11:40SGN
직항, 05시간 40분
왕복
601730
원~
베트남항공
09:30PUS
12:35SGN
직항, 05시간 05분
왕복
638160
원~</pre></body></html>`;
    const quote = parseNaverDirectRoundTrip(body, scrapedAt, undefined, {
      departureDate: "2026-12-05",
      returnDate: "2026-12-13",
    });

    expect(quote.price).toBe(601730);
    expect(quote.airline).toBe("비엣젯항공");
    expect(quote.outbound).toMatchObject({
      date: "2026-12-05",
      departureTime: "08:00",
      arrivalTime: "11:40",
      airline: "비엣젯항공",
    });
  });

  it("selects the minimum from synthetic direct candidates", async () => {
    const body = await fixture("syntheticMultipleDirect");
    const evidence = inspectNaverFixture(body);
    const quote = parseNaverDirectRoundTrip(body, scrapedAt);

    expect(evidence.directRoundTrips.length).toBeGreaterThanOrEqual(2);
    expect(quote.price).toBe(
      Math.min(...evidence.directRoundTrips.map((item) => item.price)),
    );
  });

  it("omits airline for the synthetic optional-airline edge", async () => {
    const body = await fixture("syntheticWithoutAirline");
    const quote = parseNaverDirectRoundTrip(body, scrapedAt);

    expect("airline" in quote).toBe(false);
  });

  it("rejects a normal response with no direct flight", async () => {
    const body = await fixture("noDirectFlight");

    expect(() => parseNaverDirectRoundTrip(body, scrapedAt)).toThrowError(
      expect.objectContaining<Partial<NaverParseFailure>>({
        code: "no_direct_flight",
      }),
    );
  });

  it("rejects malformed source responses", async () => {
    const body = await fixture("malformedResponse");

    expect(() => parseNaverDirectRoundTrip(body, scrapedAt)).toThrowError(
      expect.objectContaining<Partial<NaverParseFailure>>({
        code: "provider_error",
      }),
    );
  });

  it("rejects a non-ISO scrapedAt value", async () => {
    const body = await fixture("provenanceDirectRoundTrip");

    expect(() =>
      parseNaverDirectRoundTrip(body, "2026-07-14"),
    ).toThrowError(
      expect.objectContaining<Partial<NaverParseFailure>>({
        code: "provider_error",
      }),
    );
  });
});
