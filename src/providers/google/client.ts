import type { ProviderSearchInput } from "../types.js";

import {
  injectGoogleInboundLeg,
} from "./inbound-capture.js";
import { extractGoogleDirectCandidates, isGoogleResultsReady } from "./parser.js";

import { ProviderFailure } from "./failures.js";

import type { Page } from "playwright";



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

  captureInboundLeg?(

    input: ProviderSearchInput,

    signal?: AbortSignal,

  ): Promise<{ departureTime?: string; arrivalTime?: string } | null>;

}



export interface GoogleBrowserRoute {

  request(): { resourceType(): string };

  abort(): Promise<void>;

  continue(): Promise<void>;

}



export type GoogleRouteHandler = (route: GoogleBrowserRoute) => Promise<void> | void;



export interface GoogleBrowserContext {

  newPage(): Promise<GoogleBrowserPage>;

  close(): Promise<void>;

  route?(pattern: string, handler: GoogleRouteHandler): Promise<void>;

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

  createPage(
    signal?: AbortSignal,
  ): Promise<{ page: GoogleBrowserPage; cleanup: () => Promise<void> }>;

}



const TIMEOUT_MS = 120_000;

const BLOCKED_MARKERS = ["unusual traffic", "g-recaptcha", "Before you continue"];



// Images, fonts, and media never contribute to the HTML the parser reads;

// blocking them cuts page weight and per-page CPU. CSS/JS stay enabled.

export const BLOCKED_RESOURCE_TYPES = ["image", "font", "media"] as const;



export async function applyResourceBlocking(context: {

  route?(pattern: string, handler: GoogleRouteHandler): Promise<void>;

}): Promise<void> {

  if (context.route === undefined) {

    return;

  }

  const blocked = new Set<string>(BLOCKED_RESOURCE_TYPES);

  await context.route("**/*", (route) =>

    blocked.has(route.request().resourceType()) ? route.abort() : route.continue(),

  );

}



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



function abortError(): Error {

  return Object.assign(new Error("Aborted"), { name: "AbortError" });

}



function throwIfAborted(signal?: AbortSignal): void {

  if (signal?.aborted) {

    throw abortError();

  }

}



// Playwright calls (launch/newContext/newPage/goto/content) can block at the

// protocol level with no AbortSignal support. raceAbort turns an abort into an

// immediate rejection and disposes the late-arriving resource so it cannot

// leak or hold a scheduler slot.

async function raceAbort<T>(

  promise: Promise<T>,

  signal: AbortSignal | undefined,

  disposeOrphan: (value: T) => void,

): Promise<T> {

  if (signal === undefined) {

    return promise;

  }

  if (signal.aborted) {

    promise.then(disposeOrphan, () => undefined);

    throw abortError();

  }

  return await new Promise<T>((resolve, reject) => {

    const onAbort = () => {

      promise.then(disposeOrphan, () => undefined);

      reject(abortError());

    };

    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(

      (value) => {

        signal.removeEventListener("abort", onAbort);

        resolve(value);

      },

      (error) => {

        signal.removeEventListener("abort", onAbort);

        reject(error);

      },

    );

  });

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



const INBOUND_PANEL_TIMEOUT_MS = 30_000;

const RETURN_ROUTE_PATTERN = /도착\s*항공편|return/i;



function wrapHtmlRow(outerHtml: string): string {

  return `<!DOCTYPE html><html><body>${outerHtml}</body></html>`;

}



function pickLowestDirectCandidate(html: string) {

  const candidates = extractGoogleDirectCandidates(html);

  if (candidates.length === 0) {

    return null;

  }

  return candidates.reduce((best, current) =>

    current.price < best.price ? current : best,

  );

}



async function findLowestDirectRowIndex(page: Page): Promise<number | null> {

  const rows = page.locator("li.pIav2d");

  const count = await rows.count();

  let bestIndex: number | null = null;

  let bestPrice = Number.POSITIVE_INFINITY;

  for (let index = 0; index < count; index += 1) {

    const outerHtml = await rows.nth(index).evaluate((element) => element.outerHTML);

    const lowest = pickLowestDirectCandidate(wrapHtmlRow(outerHtml));

    if (lowest !== null && lowest.price < bestPrice) {

      bestPrice = lowest.price;

      bestIndex = index;

    }

  }

  return bestIndex;

}



async function waitForInboundPanel(

  page: Page,

  input: ProviderSearchInput,

  signal?: AbortSignal,

): Promise<void> {

  const returnRoute = `${input.destination}–${input.origin}`;

  const startedAt = Date.now();

  while (Date.now() - startedAt < INBOUND_PANEL_TIMEOUT_MS) {

    throwIfAborted(signal);

    const bodyText = await page.locator("body").innerText();

    if (RETURN_ROUTE_PATTERN.test(bodyText) || bodyText.includes(returnRoute)) {

      const rows = page.locator("li.pIav2d");

      if ((await rows.count()) > 0) {

        return;

      }

    }

    await sleep(500);

  }

  throw new ProviderFailure("provider_error", "Google return-flight panel did not become ready");

}



async function captureInboundLegWithPlaywright(

  page: Page,

  input: ProviderSearchInput,

  signal?: AbortSignal,

): Promise<{ departureTime?: string; arrivalTime?: string } | null> {

  const rowIndex = await findLowestDirectRowIndex(page);

  if (rowIndex === null) {

    return null;

  }

  await page.locator("li.pIav2d").nth(rowIndex).click();

  await waitForInboundPanel(page, input, signal);

  const rows = page.locator("li.pIav2d");

  const count = await rows.count();

  let best:
    | {
        price: number;
        outboundDepartureTime?: string;
        outboundArrivalTime?: string;
      }
    | null = null;

  for (let index = 0; index < count; index += 1) {

    const outerHtml = await rows.nth(index).evaluate((element) => element.outerHTML);

    const lowest = pickLowestDirectCandidate(wrapHtmlRow(outerHtml));

    if (lowest === null) {

      continue;

    }

    if (best === null || lowest.price < best.price) {

      best = lowest;

    }

  }

  if (best === null) {

    return null;

  }

  return {

    ...(best.outboundDepartureTime === undefined

      ? {}

      : { departureTime: best.outboundDepartureTime }),

    ...(best.outboundArrivalTime === undefined

      ? {}

      : { arrivalTime: best.outboundArrivalTime }),

  };

}



function wrapPlaywrightPage(page: Page): GoogleBrowserPage {

  return {

    goto: (url, options) =>

      page.goto(url, options as Parameters<Page["goto"]>[1]),

    content: () => page.content(),

    url: () => page.url(),

    close: () => page.close(),

    captureInboundLeg: (input, signal) => captureInboundLegWithPlaywright(page, input, signal),

  };

}



const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;



export class ProductionGoogleBrowserFactory implements GoogleBrowserPageFactory {

  private shared: Promise<GoogleBrowser> | null = null;

  constructor(

    private readonly deps: {

      launch: GoogleBrowserLaunch;

      env?: NodeJS.ProcessEnv;

      launchTimeoutMs?: number;

    },

  ) {}



  // A wedged Chromium launch must fail (and reset the shared slot) instead of

  // hanging every task that waits on it.

  private launchWithDeadline(): Promise<GoogleBrowser> {

    const timeoutMs = this.deps.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;

    const launched = this.deps.launch({ headless: true });

    return new Promise<GoogleBrowser>((resolve, reject) => {

      const timer = setTimeout(() => {

        launched.then(

          (browser) => void browser.close().catch(() => undefined),

          () => undefined,

        );

        reject(new Error("Google browser launch timed out"));

      }, timeoutMs);

      launched.then(

        (browser) => {

          clearTimeout(timer);

          resolve(browser);

        },

        (error) => {

          clearTimeout(timer);

          reject(error);

        },

      );

    });

  }



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

    const launchPromise = this.launchWithDeadline();

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



  async createPage(

    signal?: AbortSignal,

  ): Promise<{ page: GoogleBrowserPage; cleanup: () => Promise<void> }> {

    assertProductionBrowserAllowed(this.deps.env ?? process.env);

    throwIfAborted(signal);

    // The shared browser is not raced against the per-task signal: one task's

    // abort must not tear down the launch other tasks are waiting on.

    const browser = await this.acquireBrowser();

    throwIfAborted(signal);

    const context = await raceAbort(

      browser.newContext({

        locale: "ko-KR",

        timezoneId: "Asia/Seoul",

        userAgent:

          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",

      }),

      signal,

      (orphan) => void orphan.close().catch(() => undefined),

    );

    try {

      await applyResourceBlocking(context);

      const playwrightPage = (await raceAbort(

        context.newPage(),

        signal,

        (orphan) => void orphan.close().catch(() => undefined),

      )) as unknown as Page;

      throwIfAborted(signal);

      return {

        page: wrapPlaywrightPage(playwrightPage),

        cleanup: async () => {

          await playwrightPage.close().catch(() => undefined);

          await context.close().catch(() => undefined);

        },

      };

    } catch (error) {

      await context.close().catch(() => undefined);

      throw error;

    }

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

    const { page, cleanup } = await this.factory.createPage(signal);



    // Playwright's goto/content ignore AbortSignal; closing the page is the

    // only reliable way to reject their pending protocol calls on abort.

    let cleanedUp = false;

    const runCleanup = async () => {

      if (cleanedUp) {

        return;

      }

      cleanedUp = true;

      await cleanup();

    };

    const onAbort = () => {

      void runCleanup();

    };

    signal?.addEventListener("abort", onAbort, { once: true });



    try {

      throwIfAborted(signal);



      const url = buildGoogleSearchUrl(input);

      await page.goto(url, {

        waitUntil: "domcontentloaded",

        timeout: TIMEOUT_MS,

        ...(signal === undefined ? {} : { signal }),

      });

      throwIfAborted(signal);



      const rawHtml = await waitForReadyHtml(page, this.polling, signal);

      let body = injectCaptureUrl(rawHtml, page.url());

      if (page.captureInboundLeg !== undefined) {

        try {

          const inboundLeg = await page.captureInboundLeg(input, signal);

          if (inboundLeg !== null) {

            body = injectGoogleInboundLeg(body, inboundLeg);

          }

        } catch (error) {

          if (signal?.aborted === true) {

            throw abortError();

          }

          if (error instanceof ProviderFailure) {

            throw error;

          }

          // Keep list-only capture when the return panel fails unexpectedly.

        }

      }

      return { body, scrapedAt };

    } catch (error) {

      if (signal?.aborted === true && !(error instanceof ProviderFailure)) {

        throw abortError();

      }

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

      signal?.removeEventListener("abort", onAbort);

      await runCleanup();

    }

  }

}


