import { describe, expect, it, vi } from "vitest";
import { classifyProviderError } from "../../../src/orchestrator/error-taxonomy.js";
import { ProviderFailure } from "../../../src/providers/google/failures.js";
import {
  PlaywrightGoogleClient,
  type GoogleBrowserPage,
  type GoogleBrowserPageFactory,
} from "../../../src/providers/google/client.js";
import { GoogleFlightProvider } from "../../../src/providers/google/provider.js";
import { SourceScheduler } from "../../../src/orchestrator/queue.js";
import { createOrchestratorConfig } from "../../../src/orchestrator/config.js";

function createBlockedFactory(): GoogleBrowserPageFactory {
  const goto = vi.fn(async () => undefined);
  const content = vi.fn(async () => "<html><body>unusual traffic detected</body></html>");
  const page: GoogleBrowserPage = {
    goto,
    content,
    url: () => "https://www.google.com/travel/flights/search?q=test",
    close: vi.fn(async () => undefined),
  };
  return {
    createPage: vi.fn(async () => ({
      page,
      cleanup: vi.fn(async () => undefined),
    })),
  };
}

describe("Google DOM-only blocked metadata", () => {
  const input = {
    origin: "ICN",
    destination: "NRT",
    departureDate: "2026-10-08",
    returnDate: "2026-10-12",
    tripDays: 5,
  };

  it("keeps CAPTCHA blocking permanent and metadata-free", async () => {
    const client = new PlaywrightGoogleClient(createBlockedFactory());
    const clientError = await client.search(input).then(
      () => {
        throw new Error("expected DOM blocking");
      },
      (error: unknown) => error,
    );
    expect(clientError).toMatchObject({ code: "provider_blocked" });
    expect((clientError as ProviderFailure).status).toBeUndefined();
    expect((clientError as ProviderFailure).retryAfter).toBeUndefined();

    const provider = new GoogleFlightProvider(client);
    const providerError = await provider.findDirectRoundTrip(input).then(
      () => {
        throw new Error("expected provider blocking");
      },
      (error: unknown) => error,
    );
    expect(providerError).toMatchObject({ code: "provider_blocked" });
    expect((providerError as ProviderFailure).status).toBeUndefined();
    expect((providerError as ProviderFailure).retryAfter).toBeUndefined();

    expect(
      classifyProviderError(
        { code: "provider_blocked" },
        Date.parse("2026-07-14T00:00:00.000Z"),
      ),
    ).toMatchObject({
      code: "provider_blocked",
      transient: false,
    });
  });

  it("attempts DOM blocking only once through the scheduler", async () => {
    const sleep = vi.fn(async () => undefined);
    const config = createOrchestratorConfig({ minDelayMs: 0, maxDelayMs: 0, sleep });
    const scheduler = new SourceScheduler({
      source: "google",
      concurrency: 1,
      minDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0.5,
      sleep,
      now: () => "2026-07-14T00:00:00.000Z",
      retryBaseDelayMs: config.retryBaseDelayMs,
      retryPolicy: config.retryPolicy,
      limiterHooks: config.limiterHooks,
    });
    const provider = vi.fn(async () => {
      throw new ProviderFailure("provider_blocked", "blocked");
    });

    await scheduler.add(provider, { shouldStop: () => false });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
