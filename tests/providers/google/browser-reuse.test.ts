import { describe, expect, it, vi } from "vitest";
import {
  ProductionGoogleBrowserFactory,
  type GoogleBrowser,
  type GoogleBrowserContext,
  type GoogleBrowserPage,
} from "../../../src/providers/google/client.js";

const liveEnv = { SEARCH_WAY_ALLOW_LIVE_NETWORK: "1" };

interface FakeBrowserHandle {
  browser: GoogleBrowser;
  browserClose: ReturnType<typeof vi.fn>;
  contextCloses: Array<ReturnType<typeof vi.fn>>;
  pageCloses: Array<ReturnType<typeof vi.fn>>;
  setConnected: (connected: boolean) => void;
}

function createFakeBrowser(): FakeBrowserHandle {
  let connected = true;
  const browserClose = vi.fn(async () => undefined);
  const contextCloses: Array<ReturnType<typeof vi.fn>> = [];
  const pageCloses: Array<ReturnType<typeof vi.fn>> = [];

  const browser: GoogleBrowser = {
    async newContext() {
      const contextClose = vi.fn(async () => undefined);
      contextCloses.push(contextClose);
      const context: GoogleBrowserContext = {
        async newPage() {
          const pageClose = vi.fn(async () => undefined);
          pageCloses.push(pageClose);
          const page: GoogleBrowserPage = {
            goto: vi.fn(async () => undefined),
            content: vi.fn(async () => ""),
            url: () => "https://www.google.com/travel/flights",
            close: pageClose,
          };
          return page;
        },
        close: contextClose,
      };
      return context;
    },
    close: browserClose,
    isConnected: () => connected,
  };

  return {
    browser,
    browserClose,
    contextCloses,
    pageCloses,
    setConnected: (value) => {
      connected = value;
    },
  };
}

describe("ProductionGoogleBrowserFactory browser reuse", () => {
  it("reuses one browser across sequential createPage calls", async () => {
    const handle = createFakeBrowser();
    const launch = vi.fn(async () => handle.browser);
    const factory = new ProductionGoogleBrowserFactory({ launch, env: liveEnv });

    const first = await factory.createPage();
    await first.cleanup();
    const second = await factory.createPage();
    await second.cleanup();

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("cleanup closes the page and context but keeps the browser alive", async () => {
    const handle = createFakeBrowser();
    const launch = vi.fn(async () => handle.browser);
    const factory = new ProductionGoogleBrowserFactory({ launch, env: liveEnv });

    const { cleanup } = await factory.createPage();
    await cleanup();

    expect(handle.pageCloses[0]).toHaveBeenCalled();
    expect(handle.contextCloses[0]).toHaveBeenCalled();
    expect(handle.browserClose).not.toHaveBeenCalled();
  });

  it("shares a single launch across concurrent createPage calls", async () => {
    const handle = createFakeBrowser();
    const launch = vi.fn(async () => handle.browser);
    const factory = new ProductionGoogleBrowserFactory({ launch, env: liveEnv });

    await Promise.all([factory.createPage(), factory.createPage()]);

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("relaunches when the cached browser is disconnected", async () => {
    const first = createFakeBrowser();
    const second = createFakeBrowser();
    const launch = vi
      .fn(async () => second.browser)
      .mockResolvedValueOnce(first.browser);
    const factory = new ProductionGoogleBrowserFactory({ launch, env: liveEnv });

    await factory.createPage();
    first.setConnected(false);
    await factory.createPage();

    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("dispose closes the cached browser", async () => {
    const handle = createFakeBrowser();
    const launch = vi.fn(async () => handle.browser);
    const factory = new ProductionGoogleBrowserFactory({ launch, env: liveEnv });

    await factory.createPage();
    await factory.dispose();

    expect(handle.browserClose).toHaveBeenCalled();
  });
});
