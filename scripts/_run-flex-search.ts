// Temporary driver: exercise the real search-way MCP stdio server end-to-end.
// Starts PUS->SGN and PUS->HAN flexible searches, polls status until done,
// and writes final job snapshots to JSON files.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OUT_DIR = process.argv[2] ?? "./data/flex-run";
mkdirSync(OUT_DIR, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/mcp/server.js"],
  env: {
    ...(process.env as Record<string, string>),
    SEARCH_WAY_ALLOW_LIVE_NETWORK: "1",
    SEARCH_WAY_NAVER_HEADLESS: "1",
  },
});

const client = new Client({ name: "flex-search-driver", version: "1.0.0" });
await client.connect(transport);
console.log("connected to search-way MCP server");

interface ToolPayload {
  [key: string]: unknown;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolPayload> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content as Array<{ type: string; text: string }>)[0];
  const payload = JSON.parse(content.text) as ToolPayload;
  if (result.isError) {
    throw new Error(`${name} failed: ${content.text}`);
  }
  return payload;
}

const searchBase = {
  origin: "PUS",
  months: ["2026-11", "2026-12", "2027-01"],
  min_trip_days: 8,
  max_trip_days: 9,
  // 8-day trips must return Saturday, 9-day trips Sunday; with inclusive trip
  // days both imply a Saturday departure, so this encodes exactly that set.
  departure_weekdays: [6],
  return_weekdays: [0, 6],
  ...(process.argv[3] === undefined ? {} : { airline: process.argv[3] }),
};

const routes = ["SGN", "HAN"] as const;
const jobs: Array<{ destination: string; jobId: string }> = [];

for (const destination of routes) {
  const started = await call("start_flexible_search", { ...searchBase, destination });
  console.log(`started PUS->${destination}: job=${started.job_id} total_pairs=${started.total_pairs}`);
  jobs.push({ destination, jobId: started.job_id as string });
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const startedAt = Date.now();
const MAX_MS = 90 * 60 * 1000;

for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  let allDone = true;
  for (const job of jobs) {
    const snapshot = await call("get_search_status", { job_id: job.jobId });
    const progress = snapshot.progress as {
      total_pairs: number;
      completed_pairs: number;
      failed_pairs: number;
      google_ok: number;
      naver_ok: number;
    };
    const status = snapshot.status as string;
    console.log(
      `[${new Date().toISOString()}] PUS->${job.destination} ${status} ` +
        `${progress.completed_pairs + progress.failed_pairs}/${progress.total_pairs} ` +
        `(ok=${progress.completed_pairs} fail=${progress.failed_pairs} g=${progress.google_ok} n=${progress.naver_ok})`,
    );
    writeFileSync(join(OUT_DIR, `PUS-${job.destination}.json`), JSON.stringify(snapshot, null, 2));
    if (!TERMINAL.has(status)) {
      allDone = false;
    }
  }
  if (allDone) {
    console.log("all jobs terminal");
    break;
  }
  if (Date.now() - startedAt > MAX_MS) {
    console.log("TIMEOUT: giving up after 90 minutes; snapshots saved");
    break;
  }
}

await client.close();
process.exit(0);
