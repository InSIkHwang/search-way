import type {
  BestQuote,
  JobError,
  SearchJob,
  SearchResultRow,
} from "../jobs/types.js";
import type { Quote } from "../providers/types.js";

const serializeQuote = (quote: Quote) => ({
  price: quote.price,
  currency: quote.currency,
  url: quote.url,
  ...(quote.airline === undefined ? {} : { airline: quote.airline }),
  scraped_at: quote.scrapedAt,
});

const serializeBest = (quote: BestQuote) => ({
  source: quote.source,
  ...serializeQuote(quote),
});

const serializeResult = (row: SearchResultRow) => ({
  departure_date: row.departureDate,
  return_date: row.returnDate,
  trip_days: row.tripDays,
  google: row.google === null ? null : serializeQuote(row.google),
  naver: row.naver === null ? null : serializeQuote(row.naver),
  best: serializeBest(row.best),
});

const serializeError = (error: JobError) => ({
  departure_date: error.departureDate,
  return_date: error.returnDate,
  source: error.source,
  message: error.message,
  at: error.at,
});

export const serializeSearchJob = (job: SearchJob) => ({
  job_id: job.jobId,
  status: job.status,
  created_at: job.createdAt,
  updated_at: job.updatedAt,
  request: {
    origin: job.request.origin,
    destination: job.request.destination,
    months: [...job.request.months],
    min_trip_days: job.request.minTripDays,
    max_trip_days: job.request.maxTripDays,
    departure_weekdays: [...job.request.departureWeekdays],
    return_weekdays: [...job.request.returnWeekdays],
    ...(job.request.airline === undefined ? {} : { airline: job.request.airline }),
  },
  progress: {
    total_pairs: job.progress.totalPairs,
    completed_pairs: job.progress.completedPairs,
    failed_pairs: job.progress.failedPairs,
    google_ok: job.progress.googleOk,
    naver_ok: job.progress.naverOk,
  },
  results: [...job.results]
    .sort(
      (left, right) =>
        left.best.price - right.best.price ||
        left.departureDate.localeCompare(right.departureDate) ||
        left.returnDate.localeCompare(right.returnDate),
    )
    .map(serializeResult),
  errors: job.errors.map(serializeError),
});

export type SerializedSearchJob = ReturnType<typeof serializeSearchJob>;
