import type { ProviderSearchInput } from "../types.js";

import { isGoogleResultsReady } from "./parser.js";

import { ProviderFailure } from "./failures.js";



export interface CapturedResponse {

  body: string;

  scrapedAt: string;

}



export interface SourceClient {

  search(

    input: ProviderSearchInput,

    signal?: AbortSignal,

  ): Promise<CapturedResponse>;

}



export interface GoogleBrowserPage {

  goto(

    url: string,

    options?: { waitUntil?: string; timeout?: number; signal?: AbortSignal },

  ): Promise<unknown>;

  content(): Promise<string>;

  url(): string;

  close(): Promise<void>;

}



export interface GoogleBrowserContext {

  newPage(): Promise<GoogleBrowserPage>;

  close(): Promise<void>;

}



export interface GoogleBrowser {

  newContext(options?: Record<string, unknown>): Promise<GoogleBrowserContext>;

  close(): Promise<void>;

  isConnected?(): boolean;

}



export type GoogleBrowserLaunch = (

  options?: Record<string, unknown>,

) => Promise<GoogleBrowser>;



export interface GoogleBrowserPageFactory {

  createPage(): Promise<{ page: GoogleBrowserPage; cleanup: () => Promise<void> }>;

}



const TIMEOUT_MS = 120_000;

const BLOCKED_MARKERS = ["unusual traffic", "g-recaptcha", "Before you continue"];



export function assertProductionBrowserAllowed(

  env: NodeJS.ProcessEnv = process.env,

): void {

  if (env.VITEST !== undefined || env.CI !== undefined) {

    throw new Error(

      "production browser factory is disabled under VITEST or CI",

    );

  }

  if (env.SEARCH_WAY_ALLOW_LIVE_NETWORK !== "1") {

    throw new Error(

      "set SEARCH_WAY_ALLOW_LIVE_NETWORK=1 for manual live browser access",

    );

  }

}



export function buildGoogleSearchUrl(input: ProviderSearchInput): string {

  const query = `${input.origin} to ${input.destination} ${input.departureDate} to ${input.returnDate} direct`;

  const params = new URLSearchParams({

    q: query,

    curr: "KRW",

    hl: "ko",

  });

  return `https://www.google.com/travel/flights/search?${params.toString()}`;

}



function injectCaptureUrl(html: string, url: string): string {

  const meta = `<meta name="capture-url" content="${url.replace(/"/g, "&quot;")}" />`;

  if (/<head[^>]*>/i.test(html)) {

    return html.replace(/<head[^>]*>/i, (head) => `${head}\n  ${meta}`);

  }

  return `<!DOCTYPE html><html><head>${meta}</head><body>${html}</body></html>`;

}



function assertNotBlocked(html: string): void {

  const lower = html.toLowerCase();

  for (const marker of BLOCKED_MARKERS) {

    if (lower.includes(marker.toLowerCase())) {

      throw new ProviderFailure("provider_blocked", `Google blocked response: ${marker}`);

    }

  }

}



export interface GooglePollingOptions {

  pollIntervalMs: number;

  maxAttempts: number;

  settleIntervalMs: number;

  settleMaxChecks: number;

}



export function resolveGooglePollingOptions(

  env: NodeJS.ProcessEnv = process.env,

): GooglePollingOptions {

  if (env.VITEST !== undefined) {

    return { pollIntervalMs: 0, maxAttempts: 1, settleIntervalMs: 0, settleMaxChecks: 0 };

  }

  // 1s polling keeps the previous ~2 minute readiness budget (120 * 1s)

  // while shaving the average wait versus the old 5s interval.

  return {

    pollIntervalMs: 1_000,

    maxAttempts: 120,

    settleIntervalMs: 1_000,

    settleMaxChecks: 3,

  };

}



function sleep(milliseconds: number): Promise<void> {

  return new Promise((resolve) => setTimeout(resolve, milliseconds));

}



function throwIfAborted(signal?: AbortSignal): void {

  if (signal?.aborted) {

    throw Object.assign(new Error("Aborted"), { name: "AbortError" });

  }

}



async function settleReadyHtml(

  page: GoogleBrowserPage,

  firstReadyHtml: string,

  polling: GooglePollingOptions,

  signal?: AbortSignal,

): Promise<string> {

  let previous = firstReadyHtml;

  for (let check = 0; check < polling.settleMaxChecks; check += 1) {

    if (polling.settleIntervalMs > 0) {

      await sleep(polling.settleIntervalMs);

    }

    throwIfAborted(signal);

    const next = await page.content();

    assertNotBlocked(next);

    if (next === previous) {

      return next;

    }

    previous = next;

  }

  return previous;

}



async function waitForReadyHtml(

  page: GoogleBrowserPage,

  polling: GooglePollingOptions,

  signal?: AbortSignal,

): Promise<string> {

  for (let attempt = 0; attempt < polling.maxAttempts; attempt += 1) {

    throwIfAborted(signal);

    const html = await page.content();

    assertNotBlocked(html);

    if (isGoogleResultsReady(html)) {

      return settleReadyHtml(page, html, polling, signal);

    }

    if (polling.pollIntervalMs > 0) {

      await sleep(polling.pollIntervalMs);

    }

  }

  throw new ProviderFailure("provider_error", "Google results did not become ready");

}



export class ProductionGoogleBrowserFactory implements GoogleBrowserPageFactory {

  private shared: Promise<GoogleBrowser> | null = null;

  constructor(

    private readonly deps: {

      launch: GoogleBrowserLaunch;

      env?: NodeJS.ProcessEnv;

    },

  ) {}



  private async acquireBrowser(): Promise<GoogleBrowser> {

    if (this.shared !== null) {

      try {

        const browser = await this.shared;

        if (browser.isConnected?.() !== false) {

          return browser;

        }

      } catch {

        // A failed launch should not poison future attempts.

      }

      this.shared = null;

    }

    const launchPromise = this.deps.launch({ headless: true });

    this.shared = launchPromise;

    try {

      return await launchPromise;

    } catch (error) {

      if (this.shared === launchPromise) {

        this.shared = null;

      }

      throw error;

    }

  }



  async createPage(): Promise<{ page: GoogleBrowserPage; cleanup: () => Promise<void> }> {

    assertProductionBrowserAllowed(this.deps.env ?? process.env);

    const browser = await this.acquireBrowser();

    const context = await browser.newContext({

      locale: "ko-KR",

      timezoneId: "Asia/Seoul",

      userAgent:

        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",

    });

    const page = await context.newPage();

    return {

      page,

      cleanup: async () => {

        await page.close().catch(() => undefined);

        await context.close().catch(() => undefined);

      },

    };

  }



  async dispose(): Promise<void> {

    const pending = this.shared;

    this.shared = null;

    if (pending === null) {

      return;

    }

    try {

      const browser = await pending;

      await browser.close();

    } catch {

      // Browser already gone; nothing to release.

    }

  }

}



export class PlaywrightGoogleClient implements SourceClient {

  constructor(

    private readonly factory: GoogleBrowserPageFactory,

    private readonly polling: GooglePollingOptions = resolveGooglePollingOptions(),

  ) {}



  async search(

    input: ProviderSearchInput,

    signal?: AbortSignal,

  ): Promise<CapturedResponse> {

    const scrapedAt = new Date().toISOString();

    const { page, cleanup } = await this.factory.createPage();



    try {

      if (signal?.aborted) {

        throw Object.assign(new Error("Aborted"), { name: "AbortError" });

      }



      const url = buildGoogleSearchUrl(input);

      await page.goto(url, {

        waitUntil: "domcontentloaded",

        timeout: TIMEOUT_MS,

        ...(signal === undefined ? {} : { signal }),

      });



      const rawHtml = await waitForReadyHtml(page, this.polling, signal);

      const body = injectCaptureUrl(rawHtml, page.url());

      return { body, scrapedAt };

    } catch (error) {

      if (error instanceof ProviderFailure) {

        throw error;

      }

      if (error instanceof Error && error.name === "AbortError") {

        throw error;

      }

      throw new ProviderFailure(

        "provider_error",

        error instanceof Error ? error.message : "Google browser search failed",

        { cause: error instanceof Error ? error : undefined },

      );

    } finally {

      await cleanup();

    }

  }

}


