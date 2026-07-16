import { describe, expect, it, vi } from "vitest";
import { GoogleFlightProvider } from "../../src/providers/google/provider.js";
import { NaverFlightProvider } from "../../src/providers/naver/provider.js";
import { startFlexibleSearchInputSchema } from "../../src/mcp/validation.js";
import { serializeSearchJob } from "../../src/mcp/serialization.js";
import type { SearchJob } from "../../src/jobs/types.js";

const scrapedAt = "2026-07-16T00:00:00.000Z";

const naverBody =
  '<!DOCTYPE html><html><head><meta charset="utf-8" />' +
  '<meta name="capture-url" content="https://flight.naver.com/flights/international/x" />' +
  '</head><body><pre id="body-text">' +
  [
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
  ].join("\n") +
  "</pre></body></html>";

const googleRow = (price: string, airline: string) =>
  '<li class="pIav2d"><div aria-label="왕복 총액 ' +
  price +
  ' 대한민국 원"><span class="VG3hNb">직항</span><span class="airline">' +
  airline +
  "</span></div></li>";

const googleBody =
  '<!DOCTYPE html><html><head><meta name="capture-url" content="https://www.google.com/travel/flights/search?q=x" /></head><body><ul>' +
  googleRow("350,000", "비엣젯항공") +
  googleRow("420,000", "베트남항공") +
  "</ul></body></html>";

const input = {
  origin: "PUS",
  destination: "SGN",
  departureDate: "2026-11-07",
  returnDate: "2026-11-14",
  tripDays: 8,
  airline: "베트남항공",
};

describe("providers pass the airline filter to their parsers", () => {
  it("Naver provider returns the requested airline's lowest price", async () => {
    const client = {
      search: vi.fn(async () => ({ body: naverBody, scrapedAt })),
    };
    const provider = new NaverFlightProvider(client);

    const quote = await provider.findDirectRoundTrip(input);

    expect(quote.price).toBe(420_000);
    expect(quote.airline).toBe("베트남항공");
  });

  it("Google provider returns the requested airline's lowest price", async () => {
    const client = {
      search: vi.fn(async () => ({ body: googleBody, scrapedAt })),
    };
    const provider = new GoogleFlightProvider(client);

    const quote = await provider.findDirectRoundTrip(input);

    expect(quote.price).toBe(420_000);
    expect(quote.airline).toBe("베트남항공");
  });
});

describe("MCP schema carries the optional airline filter", () => {
  const base = {
    origin: "PUS",
    destination: "SGN",
    months: ["2026-11"],
    min_trip_days: 8,
    max_trip_days: 9,
    departure_weekdays: [6],
    return_weekdays: [0, 6],
  };

  it("accepts and maps airline to the internal request", () => {
    const parsed = startFlexibleSearchInputSchema.parse({
      ...base,
      airline: "베트남항공",
    });
    expect(parsed.airline).toBe("베트남항공");
  });

  it("stays optional", () => {
    const parsed = startFlexibleSearchInputSchema.parse(base);
    expect(parsed.airline).toBeUndefined();
  });

  it("serializes the airline back out in job snapshots", () => {
    const job: SearchJob = {
      jobId: "job-1",
      status: "completed",
      createdAt: scrapedAt,
      updatedAt: scrapedAt,
      request: {
        origin: "PUS",
        destination: "SGN",
        months: ["2026-11"],
        minTripDays: 8,
        maxTripDays: 9,
        departureWeekdays: [6],
        returnWeekdays: [0, 6],
        airline: "베트남항공",
      },
      progress: {
        totalPairs: 0,
        completedPairs: 0,
        failedPairs: 0,
        googleOk: 0,
        naverOk: 0,
      },
      results: [],
      errors: [],
      cancellationRequested: false,
    };

    const serialized = serializeSearchJob(job);

    expect(serialized.request).toMatchObject({ airline: "베트남항공" });
  });
});
