import { describe, expect, it, vi } from "vitest";
import {
  BLOCKED_RESOURCE_TYPES,
  ProductionGoogleBrowserFactory,
  type GoogleBrowser,
  type GoogleBrowserContext,
  type GoogleBrowserPage,
  type GoogleRouteHandler,
} from "../../../src/providers/google/client.js";

const liveEnv = { SEARCH_WAY_ALLOW_LIVE_NETWORK: "1" };

function createFakeBrowser(): {
  browser: GoogleBrowser;
  routeCalls: Array<{ pattern: string; handler: GoogleRouteHandler }>;
} {
  const routeCalls: Array<{ pattern: string; handler: GoogleRouteHandler }> = [];
  const browser: GoogleBrowser = {
    async newContext() {
      const context: GoogleBrowserContext = {
        async newPage() {
          const page: GoogleBrowserPage = {
            goto: vi.fn(async () => undefined),
            content: vi.fn(async () => ""),
            url: () => "https://www.google.com/travel/flights",
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

describe("Google heavy-resource blocking", () => {
  it("registers a catch-all route on each new context", async () => {
    const { browser, routeCalls } = createFakeBrowser();
    const factory = new ProductionGoogleBrowserFactory({
      launch: async () => browser,
      env: liveEnv,
    });

    await factory.createPage();

    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]!.pattern).toBe("**/*");
  });

  it("aborts images, fonts, and media but continues documents and XHR", async () => {
    const { browser, routeCalls } = createFakeBrowser();
    const factory = new ProductionGoogleBrowserFactory({
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
