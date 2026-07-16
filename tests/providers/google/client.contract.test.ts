import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlaywrightGoogleClient,
  ProductionGoogleBrowserFactory,
  buildGoogleSearchUrl,
  type GoogleBrowserPage,
  type GoogleBrowserPageFactory,
} from "../../../src/providers/google/client.js";
import {
  extractGoogleDirectCandidates,
  isGoogleResultsReady,
  parseGoogleDirectRoundTrip,
} from "../../../src/providers/google/parser.js";

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
const malformedBody = await readFile(
  fixtureUrl(manifest.fixtures.malformedResponse!.file),
  "utf8",
);

function createFakeFactory(options: {
  body?: string;
  pageUrl?: string;
  blocked?: boolean;
  abortOnGoto?: boolean;
}): {
  factory: GoogleBrowserPageFactory;
  launch: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
} {
  const launch = vi.fn();
  const goto = vi.fn(async (_url: string, gotoOptions?: { signal?: AbortSignal }) => {
    if (options.abortOnGoto) {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
    if (gotoOptions?.signal?.aborted) {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
  });
  const content = vi.fn(async () => {
    if (options.blocked) {
      return "<html><body>unusual traffic detected</body></html>";
    }
    return options.body ?? provenanceBody;
  });
  const page: GoogleBrowserPage = {
    goto,
    content,
    url: () => options.pageUrl ?? "https://www.google.com/travel/flights/search?q=test",
    close: vi.fn(async () => undefined),
  };
  const factory: GoogleBrowserPageFactory = {
    createPage: vi.fn(async () => ({
      page,
      cleanup: vi.fn(async () => undefined),
    })),
  };
  return { factory, launch, goto };
}

describe("PlaywrightGoogleClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navigates with the findings URL recipe and returns captured HTML", async () => {
    const { factory, goto } = createFakeFactory({});
    const client = new PlaywrightGoogleClient(factory);
    const input = manifest.request;

    const captured = await client.search(input);
    const expectedUrl = buildGoogleSearchUrl(input);

    expect(goto).toHaveBeenCalledWith(
      expectedUrl,
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(parseGoogleDirectRoundTrip(captured.body, captured.scrapedAt).price).toBe(417629);
  });

  it("classifies blocked interstitial responses", async () => {
    const { factory } = createFakeFactory({ blocked: true });
    const client = new PlaywrightGoogleClient(factory);

    await expect(client.search(manifest.request)).rejects.toMatchObject({
      code: "provider_blocked",
    });
  });

  it("propagates abort as AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const { factory } = createFakeFactory({});
    const client = new PlaywrightGoogleClient(factory);

    await expect(client.search(manifest.request, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects malformed extracted body before parser-level errors", async () => {
    const { factory } = createFakeFactory({ body: malformedBody });
    const client = new PlaywrightGoogleClient(factory);

    await expect(client.search(manifest.request)).rejects.toMatchObject({
      code: "provider_error",
    });
  });
});

describe("ProductionGoogleBrowserFactory", () => {
  it("rejects the actual Vitest environment", async () => {
    const launch = vi.fn();
    const factory = new ProductionGoogleBrowserFactory({ launch });

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
      const factory = new ProductionGoogleBrowserFactory({ launch, env });

      await expect(factory.createPage()).rejects.toThrow(
        "production browser factory is disabled under VITEST or CI",
      );
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("requires explicit live opt-in outside test and CI", async () => {
    const launch = vi.fn();
    const factory = new ProductionGoogleBrowserFactory({ launch, env: {} });

    await expect(factory.createPage()).rejects.toThrow(
      "set SEARCH_WAY_ALLOW_LIVE_NETWORK=1 for manual live browser access",
    );
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("buildGoogleSearchUrl", () => {
  it("builds a direct-only round-trip search URL", () => {
    const url = buildGoogleSearchUrl(manifest.request);
    expect(url).toContain("google.com/travel/flights/search");
    expect(url).toContain("curr=KRW");
    expect(url).toContain("hl=ko");
    expect(decodeURIComponent(url)).toContain("ICN+to+NRT");
    expect(decodeURIComponent(url)).toContain("direct");
  });
});
