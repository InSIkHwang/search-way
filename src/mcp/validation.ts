import { z } from "zod";
import type { FlexibleSearchRequest } from "../domain/types.js";

const iataSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/, "IATA code must contain exactly three letters"));

const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be a valid YYYY-MM");

const uniqueSorted = <T extends string | number>(values: readonly T[]): T[] =>
  [...new Set(values)].sort((left, right) =>
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right)),
  );

const monthsSchema = z
  .array(monthSchema)
  .transform(uniqueSorted)
  .pipe(z.array(monthSchema).min(1).max(3));

const weekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .default([])
  .transform(uniqueSorted);

const tripDaysRefinement = (
  value: { min_trip_days: number; max_trip_days: number },
  context: z.RefinementCtx,
): void => {
  if (value.max_trip_days < value.min_trip_days) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_trip_days"],
      message: "max_trip_days must be greater than or equal to min_trip_days",
    });
  }
};

export const startFlexibleSearchObjectSchema = z
  .object({
    origin: iataSchema,
    destination: iataSchema,
    months: monthsSchema,
    min_trip_days: z.number().int().min(2).max(30),
    max_trip_days: z.number().int().min(2).max(30),
    departure_weekdays: weekdaysSchema,
    return_weekdays: weekdaysSchema,
    airline: z.string().trim().min(1).optional(),
  })
  .strict();

export const startFlexibleSearchExternalSchema = startFlexibleSearchObjectSchema.superRefine(
  tripDaysRefinement,
);

export const startFlexibleSearchInputSchema = startFlexibleSearchExternalSchema.transform(
  (value): FlexibleSearchRequest => ({
    origin: value.origin,
    destination: value.destination,
    months: value.months,
    minTripDays: value.min_trip_days,
    maxTripDays: value.max_trip_days,
    departureWeekdays: value.departure_weekdays,
    returnWeekdays: value.return_weekdays,
    ...(value.airline === undefined ? {} : { airline: value.airline }),
  }),
);

export const jobIdExternalSchema = z
  .object({ job_id: z.string().trim().min(1) })
  .strict();

export const jobIdInputSchema = jobIdExternalSchema.transform(({ job_id }) => ({
  jobId: job_id,
}));
