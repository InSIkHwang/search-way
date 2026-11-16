import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("built MCP stdio server", () => {
  it.each(["dist/mcp/server.js", "dist/cli.js"])(
    "%s works from another working directory and completes an offline search",
    async (entry) => {
      const directory = await mkdtemp(join(tmpdir(), "search-way-mcp-"));
      const client = new Client({ name: "search-way-smoke", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve(entry)],
        cwd: directory,
        env: {
          ...process.env,
          SEARCH_WAY_OFFLINE_SMOKE: "1",
          SEARCH_WAY_DATA_DIR: directory,
        },
      });

      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
          "cancel_search",
          "get_search_status",
          "start_flexible_search",
        ]);
        const started = await client.callTool({ name: "start_flexible_search", arguments: {
          origin: "PUS", destination: "SGN", months: ["2027-03"],
          min_trip_days: 5, max_trip_days: 5, departure_weekdays: [3, 4, 5, 6],
        } });
        const payload = (result: typeof started) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
        expect(started.isError).not.toBe(true);
        const { job_id } = payload(started);
        let snapshot;
        for (let attempt = 0; attempt < 100; attempt++) {
          snapshot = payload(await client.callTool({ name: "get_search_status", arguments: { job_id } }));
          if (snapshot.status === "completed") break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(snapshot).toMatchObject({ status: "completed", progress: { total_pairs: 17, completed_pairs: 17, failed_pairs: 0 } });
      } finally {
        await client.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
