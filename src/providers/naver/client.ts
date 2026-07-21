import type { ProviderSearchInput } from "../types.js";
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

export interface NaverBrowserPage {
  goto(
    url: string,
    options?: { waitUntil?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  innerText(selector: string): Promise<string>;
  url(): string;
  close(): Promise<void>;
  evaluate?(pageFunction: () => string): Promise<string>;
}

export interface NaverBrowserRoute {
  request(): { resourceType(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}

export type NaverRouteHandler = (route: NaverBrowserRoute) => Promise<void> | void;

export interface NaverBrowserContext {
  newPage(): Promise<NaverBrowserPage>;
  close(): Promise<void>;
  route?(pattern: string, handler: NaverRouteHandler): Promise<void>;
}

export interface NaverBrowser {
  newContext(options?: Record<string, unknown>): Promise<NaverBrowserContext>;
  close(): Promise<void>;
  isConnected?(): boolean;
}

export type NaverBrowserLaunch = (
  options?: Record<string, unknown>,
) => Promise<NaverBrowser>;

export interface NaverBrowserPageFactory {
  createPage(
    signal?: AbortSignal,
  ): Promise<{ page: NaverBrowserPage; cleanup: () => Promise<void> }>;
}

const TIMEOUT_MS = 120_000;
const READY_TEXT = "직항";

// Images, fonts, and media never contribute to the text the parser reads;
// blocking them cuts page weight and per-page CPU. CSS/JS stay enabled
// because innerText only returns rendered-visible text.
export const BLOCKED_RESOURCE_TYPES = ["image", "font", "media"] as const;

export async function applyResourceBlocking(context: {
  route?(pattern: string, handler: NaverRouteHandler): Promise<void>;
}): Promise<void> {
  if (context.route === undefined) {
    return;
  }
  const blocked = new Set<string>(BLOCKED_RESOURCE_TYPES);
  await context.route("**/*", (route) =>
    blocked.has(route.request().resourceType()) ? route.abort() : route.continue(),
  );
}
const ROUND_TRIP_MARKER = "왕복";
const BLOCKED_MARKERS = ["비정상적인 접근", "captcha", "Access Denied"];

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

function toCompactDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

export function buildNaverSearchUrl(input: ProviderSearchInput): string {
  const departure = toCompactDate(input.departureDate);
  const returnDate = toCompactDate(input.returnDate);
  const path =
    `/flights/international/${input.origin}:airport-${input.destination}:airport-${departure}` +
    `/${input.destination}:airport-${input.origin}:airport-${returnDate}`;
  const params = new URLSearchParams({
    adult: "1",
    isDirect: "true",
    fareType: "Y",
  });
  return `https://flight.naver.com${path}?${params.toString()}`;
}

function wrapBodyText(bodyText: string, url: string): string {
  const escapedUrl = url.replace(/"/g, "&quot;");
  const escapedText = bodyText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="capture-url" content="${escapedUrl}" /></head><body><pre id="body-text">${escapedText}</pre></body></html>`;
}

function assertNotBlocked(bodyText: string): void {
  const lower = bodyText.toLowerCase();
  for (const marker of BLOCKED_MARKERS) {
    if (lower.includes(marker.toLowerCase())) {
      throw new ProviderFailure("provider_blocked", `Naver blocked response: ${marker}`);
    }
  }
}

export function isNaverResultsReady(bodyText: string): boolean {
  if (!bodyText.includes(READY_TEXT) || !bodyText.includes(ROUND_TRIP_MARKER)) {
    return false;
  }
  if (/편도 항공편 선택/.test(bodyText)) {
    return false;
  }
  if (/[\d,]+원/.test(bodyText)) {
    return true;
  }

  const lines = bodyText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (
      lines[index] === ROUND_TRIP_MARKER &&
      /^\d[\d,]*$/.test(lines[index + 1] ?? "") &&
      (lines[index + 2] ?? "").startsWith("원")
    ) {
      return true;
    }
  }
  return false;
}

export interface NaverPollingOptions {
  pollIntervalMs: number;
  maxAttempts: number;
  settleIntervalMs: number;
  settleMaxChecks: number;
}

export function resolveNaverPollingOptions(
  env: NodeJS.ProcessEnv = process.env,
): NaverPollingOptions {
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

// Playwright calls (launch/newContext/newPage/goto/innerText) can block at the
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

async function settleReadyBody(
  page: NaverBrowserPage,
  firstReadyBody: string,
  polling: NaverPollingOptions,
  signal?: AbortSignal,
): Promise<string> {
  let previous = firstReadyBody;
  for (let check = 0; check < polling.settleMaxChecks; check += 1) {
    if (polling.settleIntervalMs > 0) {
      await sleep(polling.settleIntervalMs);
    }
    throwIfAborted(signal);
    const next = await page.innerText("body");
    assertNotBlocked(next);
    if (next === previous) {
      return next;
    }
    previous = next;
  }
  return previous;
}

async function waitForReadyBody(
  page: NaverBrowserPage,
  polling: NaverPollingOptions,
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < polling.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const bodyText = await page.innerText("body");
    assertNotBlocked(bodyText);
    if (isNaverResultsReady(bodyText)) {
      return settleReadyBody(page, bodyText, polling, signal);
    }
    if (polling.pollIntervalMs > 0) {
      await sleep(polling.pollIntervalMs);
    }
  }
  throw new ProviderFailure("provider_error", "Naver results did not become ready");
}

export function resolveNaverBrowserLaunchOptions(headless: boolean): Record<string, unknown> {
  // Naver blocks Playwright's bundled Chromium headless shell (searchFlights
  // API never fires), so headless mode must use the real Chrome binary's new
  // headless mode. Verified live 2026-07-16: see docs/spikes/2026-07-14-naver-findings.md.
  return { headless, channel: "chrome" };
}

export function sanitizeHeadlessUserAgent(userAgent: string): string {
  return userAgent.replace(/HeadlessChrome/g, "Chrome");
}

async function readBrowserUserAgent(browser: NaverBrowser): Promise<string | null> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    if (page.evaluate === undefined) {
      return null;
    }
    const userAgent = await page.evaluate(
      () => (globalThis as unknown as { navigator: { userAgent: string } }).navigator.userAgent,
    );
    return userAgent === "" ? null : userAgent;
  } finally {
    await context.close().catch(() => undefined);
  }
}

interface SharedNaverBrowser {
  browser: NaverBrowser;
  userAgent: string | null;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;

export class ProductionNaverBrowserFactory implements NaverBrowserPageFactory {
  private shared: Promise<SharedNaverBrowser> | null = null;

  constructor(
    private readonly deps: {
      launch: NaverBrowserLaunch;
      env?: NodeJS.ProcessEnv;
      headless?: boolean;
      launchTimeoutMs?: number;
    },
  ) {}

  // A wedged Chrome launch must fail (and reset the shared slot) instead of
  // hanging every task that waits on it.
  private withLaunchDeadline(
    launched: Promise<SharedNaverBrowser>,
  ): Promise<SharedNaverBrowser> {
    const timeoutMs = this.deps.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    return new Promise<SharedNaverBrowser>((resolve, reject) => {
      const timer = setTimeout(() => {
        launched.then(
          (shared) => void shared.browser.close().catch(() => undefined),
          () => undefined,
        );
        reject(new Error("Naver browser launch timed out"));
      }, timeoutMs);
      launched.then(
        (shared) => {
          clearTimeout(timer);
          resolve(shared);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private resolveHeadless(): boolean {
    return (
      this.deps.headless ??
      (this.deps.env?.SEARCH_WAY_NAVER_HEADLESS === "1" ||
        this.deps.env?.SEARCH_WAY_NAVER_HEADLESS?.toLowerCase() === "true")
    );
  }

  private async acquireBrowser(headless: boolean): Promise<SharedNaverBrowser> {
    if (this.shared !== null) {
      try {
        const shared = await this.shared;
        if (shared.browser.isConnected?.() !== false) {
          return shared;
        }
      } catch {
        // A failed launch should not poison future attempts.
      }
      this.shared = null;
    }

    const launchPromise = this.withLaunchDeadline(
      (async (): Promise<SharedNaverBrowser> => {
        const browser = await this.deps.launch(
          resolveNaverBrowserLaunchOptions(headless),
        );
        // The "HeadlessChrome" UA token is what Naver keys on to withhold
        // search results; strip it so headless sessions match headed Chrome.
        const userAgent = headless
          ? await readBrowserUserAgent(browser)
          : null;
        return {
          browser,
          userAgent: userAgent === null ? null : sanitizeHeadlessUserAgent(userAgent),
        };
      })(),
    );
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
  ): Promise<{ page: NaverBrowserPage; cleanup: () => Promise<void> }> {
    assertProductionBrowserAllowed(this.deps.env ?? process.env);
    throwIfAborted(signal);
    const headless = this.resolveHeadless();
    // The shared browser is not raced against the per-task signal: one task's
    // abort must not tear down the launch other tasks are waiting on.
    const shared = await this.acquireBrowser(headless);
    throwIfAborted(signal);
    const contextOptions: Record<string, unknown> = {
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      viewport: { width: 1440, height: 900 },
    };
    if (shared.userAgent !== null) {
      contextOptions.userAgent = shared.userAgent;
    }
    const context = await raceAbort(
      shared.browser.newContext(contextOptions),
      signal,
      (orphan) => void orphan.close().catch(() => undefined),
    );
    try {
      await applyResourceBlocking(context);
      const page = await raceAbort(
        context.newPage(),
        signal,
        (orphan) => void orphan.close().catch(() => undefined),
      );
      throwIfAborted(signal);
      return {
        page,
        cleanup: async () => {
          await page.close().catch(() => undefined);
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
      const { browser } = await pending;
      await browser.close();
    } catch {
      // Browser already gone; nothing to release.
    }
  }
}

export class PlaywrightNaverClient implements SourceClient {
  constructor(
    private readonly factory: NaverBrowserPageFactory,
    private readonly polling: NaverPollingOptions = resolveNaverPollingOptions(),
  ) {}

  async search(
    input: ProviderSearchInput,
    signal?: AbortSignal,
  ): Promise<CapturedResponse> {
    const scrapedAt = new Date().toISOString();
    const { page, cleanup } = await this.factory.createPage(signal);

    // Playwright's goto/innerText ignore AbortSignal; closing the page is the
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

      const url = buildNaverSearchUrl(input);
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      throwIfAborted(signal);

      const bodyText = await waitForReadyBody(page, this.polling, signal);
      const body = wrapBodyText(bodyText, page.url());
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
        error instanceof Error ? error.message : "Naver browser search failed",
        { cause: error instanceof Error ? error : undefined },
      );
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await runCleanup();
    }
  }
}
