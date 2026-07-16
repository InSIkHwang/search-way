import { describe, expect, it, vi } from "vitest";
import type { ProviderSearchInput } from "../../../src/providers/types.js";
import type { CapturedResponse, SourceClient } from "../../../src/providers/google/client.js";
import { GoogleFlightProvider } from "../../../src/providers/google/provider.js";

describe("GoogleFlightProvider timeout", () => {
  const input: ProviderSearchInput = {
    origin: "ICN",
    destination: "NRT",
    departureDate: "2026-10-08",
    returnDate: "2026-10-12",
    tripDays: 5,
  };

  it("aborts the client search when the timeout fires", async () => {
    let capturedSignal: AbortSignal | undefined;
    let timeoutCallback: (() => void) | undefined;
    const setTimeout = vi.fn((callback: () => void) => {
      timeoutCallback = callback;
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    });
    const clearTimeout = vi.fn();

    const client: SourceClient = {
      search: vi.fn(async (_input, signal) => {
        capturedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
        return { body: "", scrapedAt: "2026-07-14T00:00:00.000Z" } satisfies CapturedResponse;
      }),
    };

    const provider = new GoogleFlightProvider(client, {
      requestTimeoutMs: 30_000,
      setTimeout,
      clearTimeout,
    });

    const search = provider.findDirectRoundTrip(input);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);
    timeoutCallback?.();
    await expect(search).rejects.toMatchObject({ code: "provider_timeout" });
    expect(clearTimeout).toHaveBeenCalledTimes(1);
  });

  it("clears the timeout on success", async () => {
    const clearTimeout = vi.fn();
    const client: SourceClient = {
      search: vi.fn().mockResolvedValue({
        body: `<!DOCTYPE html><html><head><meta name="capture-url" content="https://example.test" /></head><body><ul><li class="pIav2d" data-stop-count="0"><span class="VG3hNb">직항</span><span aria-label="417629 대한민국 원">₩417,629</span></li></ul></body></html>`,
        scrapedAt: "2026-07-14T00:00:00.000Z",
      }),
    };
    const provider = new GoogleFlightProvider(client, {
      requestTimeoutMs: 30_000,
      setTimeout: (callback) => {
        return globalThis.setTimeout(callback, 60_000) as unknown as ReturnType<typeof globalThis.setTimeout>;
      },
      clearTimeout,
    });

    await provider.findDirectRoundTrip(input);
    expect(clearTimeout).toHaveBeenCalledTimes(1);
  });
});
