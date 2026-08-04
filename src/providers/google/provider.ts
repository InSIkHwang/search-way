import type {
  FlightProvider,
  ProviderSearchInput,
  Quote,
} from "../types.js";
import type { SourceClient } from "./client.js";
import { ProviderFailure } from "./failures.js";
export { ProviderFailure, type ProviderFailureCode } from "./failures.js";
import {
  GoogleParseFailure,
  parseGoogleDirectRoundTrip,
} from "./parser.js";

export interface ProviderRuntimeOptions {
  requestTimeoutMs: number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

const defaultRuntimeOptions: ProviderRuntimeOptions = {
  requestTimeoutMs: 30_000,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
};

export class GoogleFlightProvider implements FlightProvider {
  readonly id = "google" as const;
  private readonly runtime: ProviderRuntimeOptions;

  constructor(
    private readonly client: SourceClient,
    runtime?: Partial<ProviderRuntimeOptions>,
  ) {
    this.runtime = { ...defaultRuntimeOptions, ...runtime };
  }

  async findDirectRoundTrip(
    input: ProviderSearchInput,
    signal?: AbortSignal,
  ): Promise<Quote> {
    const controller = new AbortController();
    const timeout = this.runtime.setTimeout(
      () => controller.abort(),
      this.runtime.requestTimeoutMs,
    );
    // Chain the caller's signal (scheduler deadline / job cancel) into the
    // provider-level controller so either source of abort stops the search.
    const onExternalAbort = () => controller.abort();
    if (signal?.aborted === true) {
      controller.abort();
    } else {
      signal?.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      const captured = await this.client.search(input, controller.signal);
      return parseGoogleDirectRoundTrip(captured.body, captured.scrapedAt, input.airline, {
        departureDate: input.departureDate,
        returnDate: input.returnDate,
      });
    } catch (error) {
      if (error instanceof ProviderFailure) {
        throw error;
      }
      if (error instanceof GoogleParseFailure) {
        throw new ProviderFailure(error.code, error.message, { cause: error });
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderFailure("provider_timeout", "Google request timed out", {
          cause: error,
        });
      }
      throw new ProviderFailure("provider_error", "Google provider failed", {
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      this.runtime.clearTimeout(timeout);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
