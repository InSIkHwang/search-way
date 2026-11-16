#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCliDefaults, getMcpConfig } from "./cli/config.js";
import { setupBrowsers } from "./cli/setup.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const [command, ...options] = args;
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(`search-way ${version}

사용법:
  search-way                    MCP 서버 실행 (stdio)
  search-way setup [--with-deps] 검색용 브라우저 설치 및 확인
  search-way config             MCP 등록용 JSON 출력
  search-way --version          버전 출력

최초 사용: npx -y search-way@${version} setup
Linux 시스템 라이브러리도 설치: npx -y search-way@${version} setup --with-deps`);
    return;
  }
  if (command === "--version" || command === "-v") {
    if (options.length) throw new Error("버전 명령에는 추가 인수를 사용할 수 없습니다.");
    console.log(version);
    return;
  }
  if (command === "config") {
    if (options.length) throw new Error("config 명령에는 추가 인수를 사용할 수 없습니다.");
    console.log(JSON.stringify(getMcpConfig(version), null, 2));
    return;
  }
  if (command === "setup") {
    if (options.some(option => option !== "--with-deps")) throw new Error("setup은 --with-deps 옵션만 지원합니다.");
    await setupBrowsers(options.includes("--with-deps"));
    console.log(JSON.stringify(getMcpConfig(version), null, 2));
    return;
  }
  if (command !== undefined) throw new Error(`지원하지 않는 명령: ${command}. --help를 확인하세요.`);
  applyCliDefaults(process.env);
  const { runStdioServer } = await import("./mcp/server.js");
  await runStdioServer();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
