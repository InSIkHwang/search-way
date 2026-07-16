import { describe, expect, it, vi } from "vitest";
import { classifyProviderError } from "../../../src/orchestrator/error-taxonomy.js";
import { ProviderFailure } from "../../../src/providers/naver/failures.js";
import {
  PlaywrightNaverClient,
  type NaverBrowserPage,
  type NaverBrowserPageFactory,
} from "../../../src/providers/naver/client.js";
import { NaverFlightProvider } from "../../../src/providers/naver/provider.js";
import { SourceScheduler } from "../../../src/orchestrator/queue.js";
import { createOrchestratorConfig } from "../../../src/orchestrator/config.js";

function createBlockedFactory(): NaverBrowserPageFactory {
  const innerText = vi.fn(async () => "직항\n왕복\n비정상적인 접근 captcha");
  const page: NaverBrowserPage = {
    goto: vi.fn(async () => undefined),
    innerText,
    url: () => "https://flight.naver.com/flights/international/test",
    close: vi.fn(async () => undefined),
  };
  return {
    createPage: vi.fn(async () => ({
      page,
      cleanup: vi.fn(async () => undefined),
    })),
  };
}

describe("Naver DOM-only blocked metadata", () => {
  const input = {
    origin: "ICN",
    destination: "NRT",
    departureDate: "2026-10-08",
    returnDate: "2026-10-12",
    tripDays: 5,
  };

  it("keeps CAPTCHA blocking permanent and metadata-free", async () => {
    const client = new PlaywrightNaverClient(createBlockedFactory());
    const clientError = await client.search(input).then(
      () => {
        throw new Error("expected DOM blocking");
      },
      (error: unknown) => error,
    );
    expect(clientError).toMatchObject({ code: "provider_blocked" });
    expect((clientError as ProviderFailure).status).toBeUndefined();
    expect((clientError as ProviderFailure).retryAfter).toBeUndefined();

    const provider = new NaverFlightProvider(client);
    const providerError = await provider.findDirectRoundTrip(input).then(
      () => {
        throw new Error("expected provider blocking");
      },
      (error: unknown) => error,
    );
    expect(providerError).toMatchObject({ code: "provider_blocked" });
    expect((providerError as ProviderFailure).status).toBeUndefined();
    expect((providerError as ProviderFailure).retryAfter).toBeUndefined();
  });

  it("attempts DOM blocking only once through the scheduler", async () => {
    const sleep = vi.fn(async () => undefined);
    const config = createOrchestratorConfig({ minDelayMs: 0, maxDelayMs: 0, sleep });
    const scheduler = new SourceScheduler({
      source: "naver",
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
