import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateDatePairs } from "../../src/domain/date-combinator.js";
import type { FlexibleSearchRequest } from "../../src/domain/types.js";
import { JsonJobStore } from "../../src/jobs/store.js";
import { createSearchOrchestrator } from "../../src/orchestrator/index.js";
import type {
  FlightProvider,
  ProviderId,
  ProviderSearchInput,
  Quote,
} from "../../src/providers/types.js";

class RecordingProvider implements FlightProvider {
  readonly calls: ProviderSearchInput[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly price: number,
  ) {}

  async findDirectRoundTrip(input: ProviderSearchInput): Promise<Quote> {
    this.calls.push(structuredClone(input));
    return {
      price: this.price,
      currency: "KRW",
      url: `https://${this.id}.example/${input.departureDate}`,
      scrapedAt: "2026-07-14T00:00:00.000Z",
    };
  }
}

describe("offline search flow", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "search-way-integration-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("enumerates, queries both sources, persists, and sorts all pairs", async () => {
    const request: FlexibleSearchRequest = {
      origin: "ICN",
      destination: "NRT",
      months: ["2026-10"],
      minTripDays: 5,
      maxTripDays: 5,
      departureWeekdays: [4],
      returnWeekdays: [1],
    };
    const google = new RecordingProvider("google", 100_000);
    const naver = new RecordingProvider("naver", 110_000);
    const orchestrator = createSearchOrchestrator({
      google,
      naver,
      store: new JsonJobStore(directory),
      generateDatePairs,
      createJobId: () => "integration-job",
      config: {
        minDelayMs: 0,
        maxDelayMs: 0,
        random: () => 0,
        sleep: async () => undefined,
        now: () => "2026-07-14T00:00:00.000Z",
      },
    });

    expect(await orchestrator.start(request)).toEqual({
      jobId: "integration-job",
      totalPairs: 5,
      status: "queued",
    });

    await orchestrator.waitForIdle("integration-job");
    const status = await orchestrator.getStatus("integration-job");

    expect(status.status).toBe("completed");
    expect(status.progress).toEqual({
      totalPairs: 5,
      completedPairs: 5,
      failedPairs: 0,
      googleOk: 5,
      naverOk: 5,
    });
    expect(google.calls).toHaveLength(5);
    expect(naver.calls).toHaveLength(5);
    expect(status.results).toHaveLength(5);
    expect(status.results.every((row) => row.best.source === "google")).toBe(true);
    expect(status.results.map((row) => row.best.price)).toEqual([
      100_000,
      100_000,
      100_000,
      100_000,
      100_000,
    ]);
  });
});
