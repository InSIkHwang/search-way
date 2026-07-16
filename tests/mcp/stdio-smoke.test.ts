import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("built MCP stdio server", () => {
  it(
    "lists the three search tools from the built server",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "search-way-mcp-"));
      const client = new Client({ name: "search-way-smoke", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["dist/mcp/server.js"],
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
      } finally {
        await client.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
