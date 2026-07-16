import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ProviderSearchInput } from "../../../src/providers/types.js";

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);

describe("google fixture schema", () => {
  it("links the request to Google final_case", async () => {
    const manifest = JSON.parse(
      await readFile(fixtureUrl("manifest.json"), "utf8"),
    ) as {
      schemaVersion: number;
      source: string;
      finalCaseSource: string;
      request: ProviderSearchInput & Record<string, unknown>;
      sanitized: boolean;
    };

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      source: "google",
      finalCaseSource:
        "docs/spikes/2026-07-14-google-findings.md#final_case",
      request: {
        roundTrip: true,
        adults: 1,
        cabin: "economy",
        directOnly: true,
      },
      sanitized: true,
    });
    expect(manifest.request.origin).toMatch(/^[A-Z]{3}$/);
    expect(manifest.request.destination).toMatch(/^[A-Z]{3}$/);
    expect(manifest.request.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.request.returnDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.request.tripDays).toBeGreaterThanOrEqual(2);
  });

  it("separates recorded provenance from synthetic edge fixtures", async () => {
    const manifest = JSON.parse(
      await readFile(fixtureUrl("manifest.json"), "utf8"),
    ) as {
      fixtures: Record<
        string,
        { file: string; provenance: string } & Record<string, unknown>
      >;
    };
    expect(manifest.fixtures.provenanceDirectRoundTrip).toMatchObject({
      provenance: "recorded",
      finalCase: true,
    });
    expect(manifest.fixtures.syntheticMultipleDirect).toMatchObject({
      provenance: "synthetic",
      purpose: "min_selection",
    });
    expect(manifest.fixtures.syntheticWithoutAirline).toMatchObject({
      provenance: "synthetic",
      purpose: "optional_airline",
    });

    const bodies = await Promise.all(
      Object.values(manifest.fixtures).map(({ file }) =>
        readFile(fixtureUrl(file), "utf8"),
      ),
    );
    const captured = bodies.join("\n");

    expect(bodies.every((body) => body.length > 0)).toBe(true);
    expect(captured).not.toMatch(
      /(?:authorization|set-cookie|csrf|session[_-]?id|access[_-]?token)\s*[:=]\s*(?!["']?SANITIZED)/i,
    );
  });
});
