import type {
  FlightProvider,
  ProviderSearchInput,
  Quote,
} from "../types.js";
import type { SourceClient } from "./client.js";
import { ProviderFailure } from "./failures.js";
export { ProviderFailure, type ProviderFailureCode } from "./failures.js";
import {
  NaverParseFailure,
  parseNaverDirectRoundTrip,
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

export class NaverFlightProvider implements FlightProvider {
  readonly id = "naver" as const;
  private readonly runtime: ProviderRuntimeOptions;

  constructor(
    private readonly client: SourceClient,
    runtime?: Partial<ProviderRuntimeOptions>,
  ) {
    this.runtime = { ...defaultRuntimeOptions, ...runtime };
  }

  async findDirectRoundTrip(input: ProviderSearchInput): Promise<Quote> {
    const controller = new AbortController();
    const timeout = this.runtime.setTimeout(
      () => controller.abort(),
      this.runtime.requestTimeoutMs,
    );
    try {
      const captured = await this.client.search(input, controller.signal);
      return parseNaverDirectRoundTrip(captured.body, captured.scrapedAt, input.airline);
    } catch (error) {
      if (error instanceof ProviderFailure) {
        throw error;
      }
      if (error instanceof NaverParseFailure) {
        throw new ProviderFailure(error.code, error.message, { cause: error });
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderFailure("provider_timeout", "Naver request timed out", {
          cause: error,
        });
      }
      throw new ProviderFailure("provider_error", "Naver provider failed", {
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      this.runtime.clearTimeout(timeout);
    }
  }
}
