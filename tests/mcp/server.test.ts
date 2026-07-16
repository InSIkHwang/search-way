import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DatePair, FlexibleSearchRequest } from "../../src/domain/types.js";
import type { SearchJob } from "../../src/jobs/types.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { McpCore } from "../../src/mcp/tools.js";

const normalizedRequest: FlexibleSearchRequest = {
  origin: "ICN",
  destination: "NRT",
  months: ["2026-10"],
  minTripDays: 2,
  maxTripDays: 3,
  departureWeekdays: [1, 6],
  returnWeekdays: [],
};

const pairA: DatePair = {
  departureDate: "2026-10-01",
  returnDate: "2026-10-02",
  tripDays: 2,
};

function createJob(status: SearchJob["status"]): SearchJob {
  return {
    jobId: "job-1",
    status,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:10.000Z",
    request: normalizedRequest,
    progress: {
      totalPairs: 1,
      completedPairs: status === "running" ? 0 : 1,
      failedPairs: 0,
      googleOk: 0,
      naverOk: status === "running" ? 0 : 1,
    },
    results: status === "running"
      ? []
      : [{
          departureDate: "2026-10-01",
          returnDate: "2026-10-02",
          tripDays: 2,
          google: null,
          naver: {
            price: 250_000,
            currency: "KRW",
            url: "https://example.test/250000",
            scrapedAt: "2026-07-14T00:00:05.000Z",
          },
          best: {
            price: 250_000,
            currency: "KRW",
            url: "https://example.test/250000",
            scrapedAt: "2026-07-14T00:00:05.000Z",
            source: "naver",
          },
        }],
    errors: [],
    cancellationRequested: status === "cancelled",
  };
}

function createFakeCore(): McpCore {
  let job = createJob("queued");
  return {
    enumerateDatePairs: vi.fn(() => [pairA]),
    start: vi.fn(async () => {
      job = createJob("running");
      return { jobId: job.jobId, totalPairs: 1, status: "queued" };
    }),
    getStatus: vi.fn(async () => job),
    cancel: vi.fn(async () => {
      job = createJob("cancelled");
      return job;
    }),
    waitForIdle: vi.fn(async () => undefined),
    recoverInterrupted: vi.fn(async () => 0),
  };
}

describe("createMcpServer", () => {
  let client: Client | undefined;
  let serverTransport: InMemoryTransport | undefined;
  let clientTransport: InMemoryTransport | undefined;
  let mcpServer: ReturnType<typeof createMcpServer> | undefined;

  afterEach(async () => {
    await client?.close();
    await mcpServer?.close();
    client = undefined;
    mcpServer = undefined;
    serverTransport = undefined;
    clientTransport = undefined;
  });

  it("lists and calls the three search tools in-process", async () => {
    const core = createFakeCore();
    mcpServer = createMcpServer({ core });
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport!);

    client = new Client({ name: "search-way-test", version: "1.0.0" });
    await client.connect(clientTransport!);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_search",
      "get_search_status",
      "start_flexible_search",
    ]);

    const startResult = await client.callTool({
      name: "start_flexible_search",
      arguments: {
        origin: "icn",
        destination: "nrt",
        months: ["2026-10", "2026-10"],
        min_trip_days: 2,
        max_trip_days: 3,
        departure_weekdays: [6, 1],
        return_weekdays: [],
      },
    });
    expect(startResult.isError).not.toBe(true);
    const startPayload = JSON.parse(String(startResult.content[0]?.text));
    expect(startPayload).toEqual({
      job_id: "job-1",
      total_pairs: 1,
      status: "queued",
    });

    const statusResult = await client.callTool({
      name: "get_search_status",
      arguments: { job_id: "job-1" },
    });
    const statusPayload = JSON.parse(String(statusResult.content[0]?.text));
    expect(statusPayload).toMatchObject({
      job_id: "job-1",
      status: "running",
      request: {
        origin: "ICN",
        min_trip_days: 2,
      },
    });

    const cancelOnce = await client.callTool({
      name: "cancel_search",
      arguments: { job_id: "job-1" },
    });
    const cancelTwice = await client.callTool({
      name: "cancel_search",
      arguments: { job_id: "job-1" },
    });
    expect(JSON.parse(String(cancelOnce.content[0]?.text))).toEqual({
      job_id: "job-1",
      status: "cancelled",
    });
    expect(JSON.parse(String(cancelTwice.content[0]?.text))).toEqual({
      job_id: "job-1",
      status: "cancelled",
    });
  });
});
