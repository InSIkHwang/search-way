import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  PlaywrightGoogleClient,
  resolveGooglePollingOptions,
  type GoogleBrowserPage,
  type GoogleBrowserPageFactory,
} from "../../../src/providers/google/client.js";

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
  };
  fixtures: Record<string, { file: string }>;
};
const readyHtml = await readFile(
  fixtureUrl(manifest.fixtures.provenanceDirectRoundTrip!.file),
  "utf8",
);
const notReadyHtml = "<html><body>로드 중</body></html>";

function markPrice(html: string, marker: string): string {
  return html.replace("</body>", `<!-- ${marker} --></body>`);
}

function createSequenceFactory(htmls: string[]): {
  factory: GoogleBrowserPageFactory;
  content: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const content = vi.fn(async () => {
    const html = htmls[Math.min(index, htmls.length - 1)]!;
    index += 1;
    return html;
  });
  const page: GoogleBrowserPage = {
    goto: vi.fn(async () => undefined),
    content,
    url: () => "https://www.google.com/travel/flights",
    close: vi.fn(async () => undefined),
  };
  const factory: GoogleBrowserPageFactory = {
    createPage: async () => ({ page, cleanup: async () => undefined }),
  };
  return { factory, content };
}

describe("resolveGooglePollingOptions", () => {
  it("uses 1s polling with the same ~2 minute budget in production", () => {
    expect(resolveGooglePollingOptions({})).toEqual({
      pollIntervalMs: 1_000,
      maxAttempts: 120,
      settleIntervalMs: 1_000,
      settleMaxChecks: 3,
    });
  });

  it("collapses to a single immediate attempt under Vitest", () => {
    expect(resolveGooglePollingOptions({ VITEST: "1" })).toEqual({
      pollIntervalMs: 0,
      maxAttempts: 1,
      settleIntervalMs: 0,
      settleMaxChecks: 0,
    });
  });
});

describe("PlaywrightGoogleClient polling", () => {
  it("polls until the page becomes ready", async () => {
    const { factory } = createSequenceFactory([
      notReadyHtml,
      markPrice(readyHtml, "attempt-2"),
    ]);
    const client = new PlaywrightGoogleClient(factory, {
      pollIntervalMs: 0,
      maxAttempts: 3,
      settleIntervalMs: 0,
      settleMaxChecks: 0,
    });

    const captured = await client.search(manifest.request);

    expect(captured.body).toContain("attempt-2");
  });

  it("keeps reading until two consecutive ready documents are identical", async () => {
    const { factory, content } = createSequenceFactory([
      markPrice(readyHtml, "draft"),
      markPrice(readyHtml, "final"),
      markPrice(readyHtml, "final"),
    ]);
    const client = new PlaywrightGoogleClient(factory, {
      pollIntervalMs: 0,
      maxAttempts: 1,
      settleIntervalMs: 0,
      settleMaxChecks: 5,
    });

    const captured = await client.search(manifest.request);

    expect(captured.body).toContain("final");
    expect(captured.body).not.toContain("draft");
    expect(content).toHaveBeenCalledTimes(3);
  });
});
