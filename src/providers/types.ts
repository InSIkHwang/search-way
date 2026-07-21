import type { DatePair } from "../domain/types.js";

export type ProviderId = "google" | "naver";

export interface Quote {
  price: number;
  currency: string;
  url: string;
  airline?: string;
  scrapedAt: string;
}

export interface ProviderSearchInput extends DatePair {
  origin: string;
  destination: string;
  airline?: string;
}

export interface FlightProvider {
  readonly id: ProviderId;
  findDirectRoundTrip(
    input: ProviderSearchInput,
    signal?: AbortSignal,
  ): Promise<Quote>;
}
