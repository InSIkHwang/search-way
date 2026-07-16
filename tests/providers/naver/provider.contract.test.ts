import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSearchInput } from "../../../src/providers/types.js";
import {
  NaverFlightProvider,
  ProviderFailure,
} from "../../../src/providers/naver/provider.js";
import type {
  CapturedResponse,
  SourceClient,
} from "../../../src/providers/naver/client.js";

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);
const manifest = JSON.parse(
  await readFile(fixtureUrl("manifest.json"), "utf8"),
) as {
  request: ProviderSearchInput;
  fixtures: Record<string, { file: string }>;
};
const body = await readFile(
  fixtureUrl(manifest.fixtures.provenanceDirectRoundTrip!.file),
  "utf8",
);
const input = manifest.request;
const captured: CapturedResponse = {
  body,
  scrapedAt: "2026-07-14T00:00:00.000Z",
};

describe("NaverFlightProvider", () => {
  it("implements FlightProvider and parses the client response", async () => {
    const client: SourceClient = { search: vi.fn().mockResolvedValue(captured) };
    const provider = new NaverFlightProvider(client);

    await expect(provider.findDirectRoundTrip(input)).resolves.toMatchObject({
      price: 367388,
      currency: "KRW",
      url: expect.stringMatching(/^https?:\/\//),
      scrapedAt: captured.scrapedAt,
    });
    expect(provider.id).toBe("naver");
    expect(client.search).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  });

  it.each([
    ["provider_timeout", Object.assign(new Error("timed out"), { name: "AbortError" })],
    ["provider_blocked", new ProviderFailure("provider_blocked", "blocked")],
  ] as const)("classifies %s", async (code, failure) => {
    const client: SourceClient = { search: vi.fn().mockRejectedValue(failure) };
    const provider = new NaverFlightProvider(client);

    await expect(provider.findDirectRoundTrip(input)).rejects.toMatchObject({ code });
  });

  it("classifies malformed responses", async () => {
    const malformedBody = await readFile(
      fixtureUrl(manifest.fixtures.malformedResponse!.file),
      "utf8",
    );
    const client: SourceClient = {
      search: vi.fn().mockResolvedValue({ ...captured, body: malformedBody }),
    };
    const provider = new NaverFlightProvider(client);

    await expect(provider.findDirectRoundTrip(input)).rejects.toMatchObject({
      code: "provider_error",
    });
  });
});
