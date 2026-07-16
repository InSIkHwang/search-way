import { describe, expect, it, vi } from "vitest";
import {
  BLOCKED_RESOURCE_TYPES,
  ProductionNaverBrowserFactory,
  type NaverBrowser,
  type NaverBrowserContext,
  type NaverBrowserPage,
  type NaverRouteHandler,
} from "../../../src/providers/naver/client.js";

const liveEnv = { SEARCH_WAY_ALLOW_LIVE_NETWORK: "1" };

function createFakeBrowser(): {
  browser: NaverBrowser;
  routeCalls: Array<{ pattern: string; handler: NaverRouteHandler }>;
} {
  const routeCalls: Array<{ pattern: string; handler: NaverRouteHandler }> = [];
  const browser: NaverBrowser = {
    async newContext() {
      const context: NaverBrowserContext = {
        async newPage() {
          const page: NaverBrowserPage = {
            goto: vi.fn(async () => undefined),
            innerText: vi.fn(async () => ""),
            url: () => "https://flight.naver.com/",
            close: vi.fn(async () => undefined),
          };
          return page;
        },
        close: vi.fn(async () => undefined),
        route: async (pattern, handler) => {
          routeCalls.push({ pattern, handler });
        },
      };
      return context;
    },
    close: vi.fn(async () => undefined),
    isConnected: () => true,
  };
  return { browser, routeCalls };
}

function fakeRoute(resourceType: string) {
  return {
    request: () => ({ resourceType: () => resourceType }),
    abort: vi.fn(async () => undefined),
    continue: vi.fn(async () => undefined),
  };
}

describe("Naver heavy-resource blocking", () => {
  it("registers a catch-all route on each new context", async () => {
    const { browser, routeCalls } = createFakeBrowser();
    const factory = new ProductionNaverBrowserFactory({
      launch: async () => browser,
      env: liveEnv,
    });

    await factory.createPage();

    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]!.pattern).toBe("**/*");
  });

  it("aborts images, fonts, and media but continues documents and XHR", async () => {
    const { browser, routeCalls } = createFakeBrowser();
    const factory = new ProductionNaverBrowserFactory({
      launch: async () => browser,
      env: liveEnv,
    });
    await factory.createPage();
    const handler = routeCalls[0]!.handler;

    for (const type of BLOCKED_RESOURCE_TYPES) {
      const route = fakeRoute(type);
      await handler(route);
      expect(route.abort).toHaveBeenCalled();
      expect(route.continue).not.toHaveBeenCalled();
    }

    for (const type of ["document", "xhr", "fetch", "script", "stylesheet"]) {
      const route = fakeRoute(type);
      await handler(route);
      expect(route.continue).toHaveBeenCalled();
      expect(route.abort).not.toHaveBeenCalled();
    }
  });
});
