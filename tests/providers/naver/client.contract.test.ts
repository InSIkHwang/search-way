import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlaywrightNaverClient,
  ProductionNaverBrowserFactory,
  buildNaverSearchUrl,
  isNaverResultsReady,
  resolveNaverBrowserLaunchOptions,
  sanitizeHeadlessUserAgent,
  type NaverBrowserPage,
  type NaverBrowserPageFactory,
} from "../../../src/providers/naver/client.js";
import { parseNaverDirectRoundTrip } from "../../../src/providers/naver/parser.js";

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);
const manifest = JSON.parse(
  await readFile(fixtureUrl("manifest.json"), "utf8"),
) as {
  request: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate: string;
    tripDays: number;
  };
  fixtures: Record<string, { file: string }>;
};
const provenanceBody = await readFile(
  fixtureUrl(manifest.fixtures.provenanceDirectRoundTrip!.file),
  "utf8",
);

function extractBodyTextFromFixture(html: string): string {
  const match = html.match(/<pre\s+id=["']body-text["'][^>]*>([\s\S]*?)<\/pre>/i);
  return match?.[1]?.trim() ?? "";
}

function createFakeFactory(options: {
  bodyText?: string;
  pageUrl?: string;
  blocked?: boolean;
}): {
  factory: NaverBrowserPageFactory;
  launch: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
} {
  const launch = vi.fn();
  const goto = vi.fn(async () => undefined);
  const bodyText =
    options.bodyText ?? extractBodyTextFromFixture(provenanceBody);
  const innerText = vi.fn(async () => {
    if (options.blocked) {
      return "직항\n왕복\n비정상적인 접근 captcha";
    }
    return bodyText;
  });
  const page: NaverBrowserPage = {
    goto,
    innerText,
    url: () =>
      options.pageUrl ??
      "https://flight.naver.com/flights/international/ICN:airport-NRT:airport-20261008/NRT:airport-ICN:airport-20261012?adult=1&isDirect=true&fareType=Y",
    close: vi.fn(async () => undefined),
  };
  const factory: NaverBrowserPageFactory = {
    createPage: vi.fn(async () => ({
      page,
      cleanup: vi.fn(async () => undefined),
    })),
  };
  return { factory, launch, goto };
}

describe("PlaywrightNaverClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navigates with the canonical airport-segment URL and returns captured body text", async () => {
    const { factory, goto } = createFakeFactory({});
    const client = new PlaywrightNaverClient(factory);
    const input = manifest.request;

    const captured = await client.search(input);
    const expectedUrl = buildNaverSearchUrl(input);

    expect(goto).toHaveBeenCalledWith(
      expectedUrl,
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(parseNaverDirectRoundTrip(captured.body, captured.scrapedAt).price).toBe(367388);
  });

  it("classifies blocked interstitial responses", async () => {
    const { factory } = createFakeFactory({ blocked: true });
    const client = new PlaywrightNaverClient(factory);

    await expect(client.search(manifest.request)).rejects.toMatchObject({
      code: "provider_blocked",
    });
  });

  it("propagates abort as AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const { factory } = createFakeFactory({});
    const client = new PlaywrightNaverClient(factory);

    await expect(client.search(manifest.request, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("returns no-direct when ready page has no price rows", async () => {
    const { factory } = createFakeFactory({
      bodyText: "직항\n왕복\n요약 1,000원\n검색",
    });
    const client = new PlaywrightNaverClient(factory);
    const captured = await client.search(manifest.request);

    expect(() =>
      parseNaverDirectRoundTrip(captured.body, captured.scrapedAt),
    ).toThrow(expect.objectContaining({ code: "no_direct_flight" }));
  });
});

describe("isNaverResultsReady", () => {
  it("requires KRW prices and rejects search-form-only pages", () => {
    expect(isNaverResultsReady(extractBodyTextFromFixture(provenanceBody))).toBe(true);
    expect(isNaverResultsReady("왕복\n직항만\n검색")).toBe(false);
    expect(isNaverResultsReady("왕복\n직항\n1,000원\n편도 항공편 선택")).toBe(false);
  });
});

describe("ProductionNaverBrowserFactory", () => {
  it("rejects the actual Vitest environment", async () => {
    const launch = vi.fn();
    const factory = new ProductionNaverBrowserFactory({ launch });

    await expect(factory.createPage()).rejects.toThrow(
      "production browser factory is disabled under VITEST or CI",
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["VITEST", "CI"] as const)(
    "rejects production browser launch when %s is present",
    async (name) => {
      const launch = vi.fn();
      const env = { [name]: "1", SEARCH_WAY_ALLOW_LIVE_NETWORK: "1" };
      const factory = new ProductionNaverBrowserFactory({ launch, env });

      await expect(factory.createPage()).rejects.toThrow(
        "production browser factory is disabled under VITEST or CI",
      );
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("requires explicit live opt-in outside test and CI", async () => {
    const launch = vi.fn();
    const factory = new ProductionNaverBrowserFactory({ launch, env: {} });

    await expect(factory.createPage()).rejects.toThrow(
      "set SEARCH_WAY_ALLOW_LIVE_NETWORK=1 for manual live browser access",
    );
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("buildNaverSearchUrl", () => {
  it("builds the canonical round-trip direct URL", () => {
    const url = buildNaverSearchUrl(manifest.request);
    expect(url).toBe(
      "https://flight.naver.com/flights/international/ICN:airport-NRT:airport-20261008/NRT:airport-ICN:airport-20261012?adult=1&isDirect=true&fareType=Y",
    );
  });
});

describe("resolveNaverBrowserLaunchOptions", () => {
  it("uses headed Chrome by default", () => {
    expect(resolveNaverBrowserLaunchOptions(false)).toEqual({
      headless: false,
      channel: "chrome",
    });
  });

  it("uses real Chrome new headless when enabled", () => {
    expect(resolveNaverBrowserLaunchOptions(true)).toEqual({
      headless: true,
      channel: "chrome",
    });
  });
});

describe("sanitizeHeadlessUserAgent", () => {
  it("strips the HeadlessChrome token Naver blocks on", () => {
    expect(
      sanitizeHeadlessUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    );
  });

  it("leaves a headed Chrome user agent untouched", () => {
    const headedUa =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
    expect(sanitizeHeadlessUserAgent(headedUa)).toBe(headedUa);
  });
});
