import { describe, expect, it, vi } from "vitest";
import {
  PlaywrightNaverClient,
  resolveNaverPollingOptions,
  type NaverBrowserPage,
  type NaverBrowserPageFactory,
} from "../../../src/providers/naver/client.js";

const request = {
  origin: "ICN",
  destination: "NRT",
  departureDate: "2026-10-08",
  returnDate: "2026-10-12",
};

const readyBody = (price: string) => `직항\n왕복\n${price}원\n선택`;
const notReadyBody = "검색 중";

function createSequenceFactory(bodies: string[]): {
  factory: NaverBrowserPageFactory;
  innerText: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const innerText = vi.fn(async () => {
    const body = bodies[Math.min(index, bodies.length - 1)]!;
    index += 1;
    return body;
  });
  const page: NaverBrowserPage = {
    goto: vi.fn(async () => undefined),
    innerText,
    url: () => "https://flight.naver.com/",
    close: vi.fn(async () => undefined),
  };
  const factory: NaverBrowserPageFactory = {
    createPage: async () => ({ page, cleanup: async () => undefined }),
  };
  return { factory, innerText };
}

describe("resolveNaverPollingOptions", () => {
  it("uses 1s polling with the same ~2 minute budget in production", () => {
    expect(resolveNaverPollingOptions({})).toEqual({
      pollIntervalMs: 1_000,
      maxAttempts: 120,
      settleIntervalMs: 1_000,
      settleMaxChecks: 3,
    });
  });

  it("collapses to a single immediate attempt under Vitest", () => {
    expect(resolveNaverPollingOptions({ VITEST: "1" })).toEqual({
      pollIntervalMs: 0,
      maxAttempts: 1,
      settleIntervalMs: 0,
      settleMaxChecks: 0,
    });
  });
});

describe("PlaywrightNaverClient polling", () => {
  it("polls until the page becomes ready", async () => {
    const { factory } = createSequenceFactory([
      notReadyBody,
      readyBody("367,388"),
    ]);
    const client = new PlaywrightNaverClient(factory, {
      pollIntervalMs: 0,
      maxAttempts: 3,
      settleIntervalMs: 0,
      settleMaxChecks: 0,
    });

    const captured = await client.search(request);

    expect(captured.body).toContain("367,388");
  });

  it("keeps reading until two consecutive ready bodies are identical", async () => {
    const { factory, innerText } = createSequenceFactory([
      readyBody("400,000"),
      readyBody("367,388"),
      readyBody("367,388"),
    ]);
    const client = new PlaywrightNaverClient(factory, {
      pollIntervalMs: 0,
      maxAttempts: 1,
      settleIntervalMs: 0,
      settleMaxChecks: 5,
    });

    const captured = await client.search(request);

    expect(captured.body).toContain("367,388");
    expect(captured.body).not.toContain("400,000");
    expect(innerText).toHaveBeenCalledTimes(3);
  });

  it("returns the last body when it never stabilizes within the check budget", async () => {
    const { factory } = createSequenceFactory([
      readyBody("1"),
      readyBody("2"),
      readyBody("3"),
    ]);
    const client = new PlaywrightNaverClient(factory, {
      pollIntervalMs: 0,
      maxAttempts: 1,
      settleIntervalMs: 0,
      settleMaxChecks: 2,
    });

    const captured = await client.search(request);

    expect(captured.body).toContain("3");
  });
});
