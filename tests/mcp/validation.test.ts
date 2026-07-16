import { describe, expect, it } from "vitest";
import {
  jobIdInputSchema,
  startFlexibleSearchInputSchema,
} from "../../src/mcp/validation.js";

const validInput = {
  origin: " icn ",
  destination: "nrt",
  months: ["2026-10"],
  min_trip_days: 2,
  max_trip_days: 7,
};

describe("startFlexibleSearchInputSchema", () => {
  it("normalizes external snake_case input to the internal contract", () => {
    expect(
      startFlexibleSearchInputSchema.parse({
        ...validInput,
        months: ["2026-11", "2026-10", "2026-11"],
        departure_weekdays: [6, 1, 6],
        return_weekdays: [],
      }),
    ).toEqual({
      origin: "ICN",
      destination: "NRT",
      months: ["2026-10", "2026-11"],
      minTripDays: 2,
      maxTripDays: 7,
      departureWeekdays: [1, 6],
      returnWeekdays: [],
    });
  });

  it.each([
    [{ ...validInput, origin: "SEOUL" }, "IATA"],
    [{ ...validInput, months: [] }, "month"],
    [{ ...validInput, months: ["2026-00"] }, "month"],
    [{ ...validInput, months: ["2026-13"] }, "month"],
    [{ ...validInput, months: ["2026-01", "2026-02", "2026-03", "2026-04"] }, "month"],
    [{ ...validInput, min_trip_days: 1 }, "trip"],
    [{ ...validInput, min_trip_days: 8, max_trip_days: 7 }, "trip"],
    [{ ...validInput, max_trip_days: 31 }, "trip"],
    [{ ...validInput, departure_weekdays: [-1] }, "weekday"],
    [{ ...validInput, return_weekdays: [7] }, "weekday"],
    [{ ...validInput, departure_weekdays: [1.5] }, "weekday"],
    [{ ...validInput, unexpected: true }, "unrecognized"],
  ])("rejects invalid input before job creation: %j", (input) => {
    expect(startFlexibleSearchInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("jobIdInputSchema", () => {
  it("trims a non-empty job_id", () => {
    expect(jobIdInputSchema.parse({ job_id: " 01J0123456789ABCDEFGHJKMNP " }))
      .toEqual({ jobId: "01J0123456789ABCDEFGHJKMNP" });
  });

  it("rejects empty and unknown keys", () => {
    expect(jobIdInputSchema.safeParse({ job_id: " " }).success).toBe(false);
    expect(jobIdInputSchema.safeParse({ job_id: "x", extra: 1 }).success).toBe(false);
  });
});
