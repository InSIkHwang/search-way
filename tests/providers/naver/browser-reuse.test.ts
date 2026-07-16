import { describe, expect, it, vi } from "vitest";
import {
  ProductionNaverBrowserFactory,
  type NaverBrowser,
  type NaverBrowserContext,
  type NaverBrowserPage,
} from "../../../src/providers/naver/client.js";

const liveEnv = { SEARCH_WAY_ALLOW_LIVE_NETWORK: "1" };

interface FakeBrowserHandle {
  browser: NaverBrowser;
  browserClose: ReturnType<typeof vi.fn>;
  contextCloses: Array<ReturnType<typeof vi.fn>>;
  pageCloses: Array<ReturnType<typeof vi.fn>>;
  evaluateCalls: () => number;
  setConnected: (connected: boolean) => void;
}

function createFakeBrowser(): FakeBrowserHandle {
  let connected = true;
  let evaluateCalls = 0;
  const browserClose = vi.fn(async () => undefined);
  const contextCloses: Array<ReturnType<typeof vi.fn>> = [];
  const pageCloses: Array<ReturnType<typeof vi.fn>> = [];

  const browser: NaverBrowser = {
    async newContext() {
      const contextClose = vi.fn(async () => undefined);
      contextCloses.push(contextClose);
      const context: NaverBrowserContext = {
        async newPage() {
          const pageClose = vi.fn(async () => undefined);
          pageCloses.push(pageClose);
          const page: NaverBrowserPage = {
            goto: vi.fn(async () => undefined),
            innerText: vi.fn(async () => ""),
            url: () => "https://flight.naver.com/",
            close: pageClose,
            evaluate: vi.fn(async () => {
              evaluateCalls += 1;
              return "Mozilla/5.0 HeadlessChrome/150.0.0.0 Safari/537.36";
            }),
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
    evaluateCalls: () => evaluateCalls,
    setConnected: (value) => {
      connected = value;
    },
  };
}

describe("ProductionNaverBrowserFactory browser reuse", () => {
  it("reuses one browser across sequential createPage calls", async () => {
    const handle = createFakeBrowser();
    const launch = vi.fn(async () => handle.browser);
    const factory = new ProductionNaverBrowserFactory({ launch, env: liveEnv });

    const first = await factory.createPage();
    await first.cleanup();
    const second = await factory.createPage();
    await second.cleanup();

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("cleanup closes the page and context but keeps the browser alive", async () => {
    const handle = createFakeBrowser();
    const launch = vi.fn(async () => handle.browser);
    const factory = new ProductionNaverBrowserFactory({ launch, env: liveEnv });

    const { cleanup } = await factory.createPage();
    await cleanup();

    expect(handle.pageCloses[0]).toHaveBeenCalled();
    expect(handle.contextCloses.at(-1)).toHaveBeenCalled();
    expect(handle.browserClose).not.toHaveBeenCalled();
  });

  it("shares a single launch across concurrent createPage calls", async () => {
    const handle = createFakeBrowser();
    const launch = vi.fn(async () => handle.browser);
    const factory = new ProductionNaverBrowserFactory({ launch, env: liveEnv });

    await Promise.all([factory.createPage(), factory.createPage()]);

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("relaunches when the cached browser is disconnected", async () => {
    const first = createFakeBrowser();
    const second = createFakeBrowser();
    const launch = vi
      .fn(async () => second.browser)
      .mockResolvedValueOnce(first.browser);
    const factory = new ProductionNaverBrowserFactory({ launch, env: liveEnv });

    await factory.createPage();
    first.setConnected(false);
    await factory.createPage();

    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("reads the headless user agent once per browser instance", async () => {
    const handle = createFakeBrowser();
    const launch = vi.fn(async () => handle.browser);
    const factory = new ProductionNaverBrowserFactory({
      launch,
      env: liveEnv,
      headless: true,
    });

    await factory.createPage();
    await factory.createPage();

    expect(handle.evaluateCalls()).toBe(1);
  });

  it("dispose closes the cached browser", async () => {
    const handle = createFakeBrowser();
    const launch = vi.fn(async () => handle.browser);
    const factory = new ProductionNaverBrowserFactory({ launch, env: liveEnv });

    await factory.createPage();
    await factory.dispose();

    expect(handle.browserClose).toHaveBeenCalled();
  });
});
