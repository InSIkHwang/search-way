import { describe, expect, it, vi } from "vitest";
import {
  PlaywrightGoogleClient,
  ProductionGoogleBrowserFactory,
  type GoogleBrowser,
  type GoogleBrowserContext,
  type GoogleBrowserPage,
  type GoogleBrowserPageFactory,
} from "../../../src/providers/google/client.js";

const liveEnv = { SEARCH_WAY_ALLOW_LIVE_NETWORK: "1" };

const input = {
  origin: "PUS",
  destination: "PQC",
  departureDate: "2026-10-01",
  returnDate: "2026-10-05",
  tripDays: 5,
};

describe("PlaywrightGoogleClient abort hard-close", () => {
  it("closes the page on abort so a hung content() call cannot hold the task", async () => {
    // content() stays pending until close() rejects it, mimicking a wedged
    // Playwright protocol call that ignores AbortSignal.
    let rejectContent: ((error: Error) => void) | undefined;
    const cleanup = vi.fn(async () => {
      rejectContent?.(new Error("Target page, context or browser has been closed"));
    });
    const page: GoogleBrowserPage = {
      goto: vi.fn(async () => undefined),
      content: vi.fn(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectContent = reject;
          }),
      ),
      url: () => "https://www.google.com/travel/flights",
      close: vi.fn(async () => undefined),
    };
    const factory: GoogleBrowserPageFactory = {
      createPage: vi.fn(async () => ({ page, cleanup })),
    };

    const client = new PlaywrightGoogleClient(factory, {
      pollIntervalMs: 0,
      maxAttempts: 1,
      settleIntervalMs: 0,
      settleMaxChecks: 0,
    });

    const controller = new AbortController();
    const search = client.search(input, controller.signal);

    await vi.waitFor(() => expect(page.content).toHaveBeenCalled());
    controller.abort();

    await expect(search).rejects.toMatchObject({ name: "AbortError" });
    expect(cleanup).toHaveBeenCalled();
  });
});

describe("ProductionGoogleBrowserFactory abort during createPage", () => {
  it("rejects immediately and disposes the late context when newContext hangs", async () => {
    let resolveContext: ((context: GoogleBrowserContext) => void) | undefined;
    const contextClose = vi.fn(async () => undefined);
    const hangingContext: GoogleBrowserContext = {
      newPage: vi.fn(async () => ({}) as GoogleBrowserPage),
      close: contextClose,
    };
    const browser: GoogleBrowser = {
      newContext: () =>
        new Promise<GoogleBrowserContext>((resolve) => {
          resolveContext = resolve;
        }),
      close: vi.fn(async () => undefined),
      isConnected: () => true,
    };
    const factory = new ProductionGoogleBrowserFactory({
      launch: vi.fn(async () => browser),
      env: liveEnv,
    });

    const controller = new AbortController();
    const creating = factory.createPage(controller.signal);
    await vi.waitFor(() => expect(resolveContext).toBeDefined());

    controller.abort();
    await expect(creating).rejects.toMatchObject({ name: "AbortError" });

    // The context that eventually materialises is orphaned and must be closed.
    resolveContext!(hangingContext);
    await vi.waitFor(() => expect(contextClose).toHaveBeenCalled());
  });
});
