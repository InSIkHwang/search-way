/// <reference types="node" />
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium } from "playwright";
import { ulid } from "ulid";
import { loadRuntimeConfig } from "../config/runtime.js";
import { generateDatePairs } from "../domain/date-combinator.js";
import { JsonJobStore } from "../jobs/store.js";
import {
  createOrchestratorConfig,
  type OrchestratorConfig,
} from "../orchestrator/config.js";
import {
  createSearchOrchestrator,
  type SearchOrchestrator,
  type SourceSchedulers,
} from "../orchestrator/index.js";
import { SourceScheduler, type SourceSchedulerOptions } from "../orchestrator/queue.js";
import {
  PlaywrightGoogleClient,
  ProductionGoogleBrowserFactory,
  type GoogleBrowserLaunch,
} from "../providers/google/client.js";
import {
  GoogleFlightProvider,
  type ProviderRuntimeOptions,
} from "../providers/google/provider.js";
import {
  PlaywrightNaverClient,
  ProductionNaverBrowserFactory,
  type NaverBrowserLaunch,
} from "../providers/naver/client.js";
import { NaverFlightProvider } from "../providers/naver/provider.js";
import type { FlightProvider } from "../providers/types.js";
import {
  createMcpTools,
  type McpCore,
  type ToolResult,
} from "./tools.js";
import {
  jobIdExternalSchema,
  startFlexibleSearchObjectSchema,
} from "./validation.js";

export interface ServerOptions {
  core: McpCore;
}

export interface ProductionComposition {
  core: McpCore;
  orchestrator: SearchOrchestrator;
  schedulers: SourceSchedulers;
  orchestratorConfig: OrchestratorConfig;
  googleProviderOptions: ProviderRuntimeOptions;
  naverProviderOptions: ProviderRuntimeOptions;
}

export interface ProductionCompositionOptions {
  env?: NodeJS.ProcessEnv;
  createScheduler?: (options: SourceSchedulerOptions) => SourceScheduler;
}

function toCallToolResult(result: ToolResult) {
  if (result.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: result.error }) }],
    isError: true as const,
  };
}

export function createMcpServer(options: ServerOptions): McpServer {
  const tools = createMcpTools(options.core);
  const server = new McpServer({
    name: "search-way",
    version: "1.0.0",
  });

  server.registerTool(
    "start_flexible_search",
    {
      description:
        "Start an asynchronous flexible flight search. Poll get_search_status for partial or final results.",
      inputSchema: startFlexibleSearchObjectSchema.shape,
    },
    async (input) => toCallToolResult(await tools.start(input)),
  );

  server.registerTool(
    "get_search_status",
    {
      description:
        "Read the current job snapshot. Results may be partial while the search is running. Each result includes summary (human-readable), and outbound/inbound legs with date, optional departure_time, arrival_time, and airline on google, naver, and best quotes.",
      inputSchema: jobIdExternalSchema.shape,
    },
    async (input) => toCallToolResult(await tools.getStatus(input)),
  );

  server.registerTool(
    "cancel_search",
    {
      description:
        "Request cooperative cancellation for a queued or running search. Completed partial results are preserved.",
      inputSchema: jobIdExternalSchema.shape,
    },
    async (input) => toCallToolResult(await tools.cancel(input)),
  );

  return server;
}

function createOfflineQuote(price: number) {
  return {
    price,
    currency: "KRW" as const,
    url: "https://example.test/offline-smoke",
    scrapedAt: "2026-07-14T00:00:00.000Z",
  };
}

function createOfflineProviders(): {
  google: FlightProvider;
  naver: FlightProvider;
} {
  return {
    google: {
      id: "google",
      findDirectRoundTrip: async () => createOfflineQuote(400_000),
    },
    naver: {
      id: "naver",
      findDirectRoundTrip: async () => createOfflineQuote(350_000),
    },
  };
}

function createLiveProviders(runtime: {
  google: ProviderRuntimeOptions;
  naver: ProviderRuntimeOptions;
  naverHeadless: boolean;
  env: NodeJS.ProcessEnv;
}): {
  google: FlightProvider;
  naver: FlightProvider;
} {
  const googleClient = new PlaywrightGoogleClient(
    new ProductionGoogleBrowserFactory({
      launch: (options) => chromium.launch(options) as unknown as ReturnType<GoogleBrowserLaunch>,
      env: runtime.env,
    }),
  );
  const naverClient = new PlaywrightNaverClient(
    new ProductionNaverBrowserFactory({
      launch: (options) => chromium.launch(options) as unknown as ReturnType<NaverBrowserLaunch>,
      env: runtime.env,
      headless: runtime.naverHeadless,
    }),
  );
  return {
    google: new GoogleFlightProvider(googleClient, runtime.google),
    naver: new NaverFlightProvider(naverClient, runtime.naver),
  };
}

export function composeProductionStack(
  options: ProductionCompositionOptions = {},
): ProductionComposition {
  const env = options.env ?? process.env;
  const runtime = loadRuntimeConfig(env);
  const Scheduler = options.createScheduler ?? ((schedulerOptions) => new SourceScheduler(schedulerOptions));
  const orchestratorConfig = createOrchestratorConfig({
    concurrencyPerSource: runtime.concurrencyPerSource,
    minDelayMs: runtime.minDelayMs,
    maxDelayMs: runtime.maxDelayMs,
    retryBaseDelayMs: runtime.retryBaseDelayMs,
    taskDeadlineMs: runtime.taskDeadlineMs,
    taskKillGraceMs: runtime.taskKillGraceMs,
    stallTimeoutMs: runtime.stallTimeoutMs,
    retryPolicy: {
      maxAttempts: runtime.maxRetries + 1,
      shouldRetry: (error, attempt) =>
        attempt < runtime.maxRetries + 1 &&
        createOrchestratorConfig().retryPolicy.shouldRetry(error, attempt),
    },
    ...(env.SEARCH_WAY_OFFLINE_SMOKE === "1"
      ? { minDelayMs: 0, maxDelayMs: 0 }
      : {}),
  });

  const googleProviderOptions: ProviderRuntimeOptions = {
    requestTimeoutMs: runtime.requestTimeoutMs,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  const naverProviderOptions: ProviderRuntimeOptions = {
    requestTimeoutMs: runtime.requestTimeoutMs,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };

  const schedulers: SourceSchedulers = {
    google: Scheduler({
      source: "google",
      concurrency: orchestratorConfig.concurrencyPerSource,
      minDelayMs: orchestratorConfig.minDelayMs,
      maxDelayMs: orchestratorConfig.maxDelayMs,
      random: orchestratorConfig.random,
      sleep: orchestratorConfig.sleep,
      now: orchestratorConfig.now,
      retryBaseDelayMs: orchestratorConfig.retryBaseDelayMs,
      retryPolicy: orchestratorConfig.retryPolicy,
      limiterHooks: orchestratorConfig.limiterHooks,
      taskDeadlineMs: orchestratorConfig.taskDeadlineMs,
      taskKillGraceMs: orchestratorConfig.taskKillGraceMs,
      setTimeout: orchestratorConfig.setTimeoutFn,
      clearTimeout: orchestratorConfig.clearTimeoutFn,
    }),
    naver: Scheduler({
      source: "naver",
      concurrency: orchestratorConfig.concurrencyPerSource,
      minDelayMs: orchestratorConfig.minDelayMs,
      maxDelayMs: orchestratorConfig.maxDelayMs,
      random: orchestratorConfig.random,
      sleep: orchestratorConfig.sleep,
      now: orchestratorConfig.now,
      retryBaseDelayMs: orchestratorConfig.retryBaseDelayMs,
      retryPolicy: orchestratorConfig.retryPolicy,
      limiterHooks: orchestratorConfig.limiterHooks,
      taskDeadlineMs: orchestratorConfig.taskDeadlineMs,
      taskKillGraceMs: orchestratorConfig.taskKillGraceMs,
      setTimeout: orchestratorConfig.setTimeoutFn,
      clearTimeout: orchestratorConfig.clearTimeoutFn,
    }),
  };

  if (env.SEARCH_WAY_OFFLINE_SMOKE === "1" && env.SEARCH_WAY_DATA_DIR === undefined) {
    throw new Error("SEARCH_WAY_DATA_DIR is required for offline smoke");
  }

  const store = new JsonJobStore(runtime.dataDir);
  const providers =
    env.SEARCH_WAY_OFFLINE_SMOKE === "1"
      ? createOfflineProviders()
      : createLiveProviders({
          google: googleProviderOptions,
          naver: naverProviderOptions,
          naverHeadless: runtime.naverHeadless,
          env,
        });

  const orchestrator = createSearchOrchestrator({
    ...providers,
    store,
    generateDatePairs,
    createJobId: ulid,
    config: orchestratorConfig,
    schedulers,
  });

  const core: McpCore = {
    enumerateDatePairs: generateDatePairs,
    start: (request) => orchestrator.start(request),
    getStatus: (jobId) => orchestrator.getStatus(jobId),
    cancel: (jobId) => orchestrator.cancel(jobId),
    waitForIdle: (jobId) => orchestrator.waitForIdle(jobId),
    recoverInterrupted: () => orchestrator.recoverInterrupted(),
  };

  return {
    core,
    orchestrator,
    schedulers,
    orchestratorConfig,
    googleProviderOptions,
    naverProviderOptions,
  };
}

async function createProductionCore(): Promise<McpCore> {
  const stack = composeProductionStack();
  await stack.core.recoverInterrupted();
  return stack.core;
}

export async function runStdioServer(): Promise<void> {
  const core = await createProductionCore();
  const server = createMcpServer({ core });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const entryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";

if (entryPath === invokedPath) {
  runStdioServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
