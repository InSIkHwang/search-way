import { describe, expect, it } from "vitest";
import type { SearchJob } from "../../src/jobs/types.js";
import type { Quote } from "../../src/providers/types.js";
import { serializeSearchJob } from "../../src/mcp/serialization.js";

const quote = (price: number, scrapedAt: string): Quote => ({
  price,
  currency: "KRW",
  url: `https://example.test/${price}`,
  scrapedAt,
  airline: "테스트항공",
  outbound: {
    date: "2026-10-01",
    departureTime: "08:00",
    arrivalTime: "11:30",
    airline: "테스트항공",
  },
  inbound: {
    date: "2026-10-02",
    departureTime: "12:00",
    arrivalTime: "15:30",
    airline: "테스트항공",
  },
});

const makeJob = (): SearchJob => {
  const expensive = quote(300_000, "2026-07-14T00:00:20.000Z");
  const cheap = quote(200_000, "2026-07-14T00:00:30.000Z");
  return {
    jobId: "01JTEST",
    status: "running",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:01:00.000Z",
    request: {
      origin: "ICN",
      destination: "NRT",
      months: ["2026-10"],
      minTripDays: 2,
      maxTripDays: 4,
      departureWeekdays: [],
      returnWeekdays: [],
    },
    progress: {
      totalPairs: 3,
      completedPairs: 2,
      failedPairs: 1,
      googleOk: 1,
      naverOk: 1,
    },
    results: [
      {
        departureDate: "2026-10-01",
        returnDate: "2026-10-02",
        tripDays: 2,
        google: expensive,
        naver: null,
        best: { ...expensive, source: "google" },
      },
      {
        departureDate: "2026-10-02",
        returnDate: "2026-10-03",
        tripDays: 2,
        google: null,
        naver: cheap,
        best: { ...cheap, source: "naver" },
      },
    ],
    errors: [{
      departureDate: "2026-10-03",
      returnDate: "2026-10-04",
      source: "google",
      code: "provider_timeout",
      message: "timeout",
      at: "2026-07-14T00:00:40.000Z",
    }],
    cancellationRequested: false,
  };
};

describe("serializeSearchJob", () => {
  it("maps nested camelCase fields, errors, and sorted partial results", () => {
    const job = makeJob();
    const serialized = serializeSearchJob(job);

    expect(serialized).toMatchObject({
      job_id: "01JTEST",
      status: "running",
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:01:00.000Z",
      request: {
        origin: "ICN",
        destination: "NRT",
        months: ["2026-10"],
        min_trip_days: 2,
        max_trip_days: 4,
        departure_weekdays: [],
        return_weekdays: [],
      },
      progress: {
        total_pairs: 3,
        completed_pairs: 2,
        failed_pairs: 1,
        google_ok: 1,
        naver_ok: 1,
      },
    });
    expect(serialized.results.map((row) => row.best.price)).toEqual([200_000, 300_000]);
    expect(serialized.results[0]).toMatchObject({
      departure_date: "2026-10-02",
      return_date: "2026-10-03",
      trip_days: 2,
      summary: "가는 편 2026-10-01 08:00→11:30 테스트항공 | 오는 편 2026-10-02 12:00→15:30 테스트항공 | ₩200,000 (naver)",
      best: {
        source: "naver",
        scraped_at: "2026-07-14T00:00:30.000Z",
        outbound: {
          date: "2026-10-01",
          departure_time: "08:00",
          arrival_time: "11:30",
          airline: "테스트항공",
        },
        inbound: {
          date: "2026-10-02",
          departure_time: "12:00",
          arrival_time: "15:30",
          airline: "테스트항공",
        },
      },
    });
    expect(serialized.errors).toEqual([{
      departure_date: "2026-10-03",
      return_date: "2026-10-04",
      source: "google",
      message: "timeout",
      at: "2026-07-14T00:00:40.000Z",
    }]);
    expect(job.results.map((row) => row.best.price)).toEqual([300_000, 200_000]);
  });

  it("breaks equal-price ties by departure then return date", () => {
    const job = makeJob();
    job.results = job.results.map((row) => ({
      ...row,
      best: { ...row.best, price: 250_000 },
    })).reverse();

    expect(serializeSearchJob(job).results.map((row) => [
      row.departure_date,
      row.return_date,
    ])).toEqual([
      ["2026-10-01", "2026-10-02"],
      ["2026-10-02", "2026-10-03"],
    ]);
  });
});
