import type { DatePair, FlexibleSearchRequest } from "../domain/types.js";
import type { ProviderId, Quote } from "../providers/types.js";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface BestQuote extends Quote {
  source: ProviderId;
}

export interface SearchResultRow extends DatePair {
  google: Quote | null;
  naver: Quote | null;
  best: BestQuote;
}

export interface SearchProgress {
  totalPairs: number;
  completedPairs: number;
  failedPairs: number;
  googleOk: number;
  naverOk: number;
}

export type JobErrorCode =
  | "provider_timeout"
  | "provider_blocked"
  | "no_direct_flight"
  | "currency_mismatch"
  | "provider_error";

export interface JobError {
  departureDate: string;
  returnDate: string;
  source: ProviderId;
  code: JobErrorCode;
  message: string;
  at: string;
}

export interface SearchJob {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  request: FlexibleSearchRequest;
  progress: SearchProgress;
  results: SearchResultRow[];
  errors: JobError[];
  cancellationRequested: boolean;
  failureReason?: "interrupted" | "store_error" | "startup_error" | "stalled";
}
