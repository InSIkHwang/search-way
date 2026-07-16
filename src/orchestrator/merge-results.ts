import type { DatePair } from "../domain/types.js";
import type { JobError, SearchResultRow } from "../jobs/types.js";
import type { ProviderId, Quote } from "../providers/types.js";

export type CellOutcome =
  | { kind: "success"; source: ProviderId; quote: Quote }
  | { kind: "failure"; source: ProviderId; error: JobError }
  | { kind: "cancelled"; source: ProviderId };

export interface PairMerge {
  row: SearchResultRow | null;
  errors: JobError[];
  failed: boolean;
  googleOk: number;
  naverOk: number;
}

export function mergePair(
  pair: DatePair,
  google: CellOutcome,
  naver: CellOutcome,
  now: () => string,
): PairMerge {
  if (google.kind === "cancelled" || naver.kind === "cancelled") {
    throw new Error("cancelled pair cannot be merged");
  }

  const googleQuote = google.kind === "success" ? google.quote : null;
  const naverQuote = naver.kind === "success" ? naver.quote : null;
  const errors: JobError[] = [];

  if (google.kind === "failure") {
    errors.push(google.error);
  }
  if (naver.kind === "failure") {
    errors.push(naver.error);
  }

  if (googleQuote && naverQuote && googleQuote.currency !== naverQuote.currency) {
    const at = now();
    errors.push(
      {
        departureDate: pair.departureDate,
        returnDate: pair.returnDate,
        source: "google",
        code: "currency_mismatch",
        message: `Cannot compare ${googleQuote.currency} with ${naverQuote.currency}`,
        at,
      },
      {
        departureDate: pair.departureDate,
        returnDate: pair.returnDate,
        source: "naver",
        code: "currency_mismatch",
        message: `Cannot compare ${googleQuote.currency} with ${naverQuote.currency}`,
        at,
      },
    );
    return { row: null, errors, failed: true, googleOk: 1, naverOk: 1 };
  }

  if (!googleQuote && !naverQuote) {
    return { row: null, errors, failed: true, googleOk: 0, naverOk: 0 };
  }

  const best =
    googleQuote && naverQuote
      ? googleQuote.price <= naverQuote.price
        ? { ...googleQuote, source: "google" as const }
        : { ...naverQuote, source: "naver" as const }
      : googleQuote
        ? { ...googleQuote, source: "google" as const }
        : { ...naverQuote!, source: "naver" as const };

  return {
    row: {
      departureDate: pair.departureDate,
      returnDate: pair.returnDate,
      tripDays: pair.tripDays,
      google: googleQuote,
      naver: naverQuote,
      best,
    },
    errors,
    failed: false,
    googleOk: googleQuote ? 1 : 0,
    naverOk: naverQuote ? 1 : 0,
  };
}

export function sortResults(rows: SearchResultRow[]): SearchResultRow[] {
  return [...rows].sort((left, right) => {
    if (left.best.price !== right.best.price) {
      return left.best.price - right.best.price;
    }
    if (left.departureDate !== right.departureDate) {
      return left.departureDate.localeCompare(right.departureDate);
    }
    return left.returnDate.localeCompare(right.returnDate);
  });
}
