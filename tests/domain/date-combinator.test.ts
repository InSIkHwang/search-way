import { describe, expect, it } from "vitest";

import { generateDatePairs } from "../../src/domain/date-combinator.js";
import type { FlexibleSearchRequest } from "../../src/domain/types.js";

function request(
  overrides: Partial<FlexibleSearchRequest> = {},
): FlexibleSearchRequest {
  return {
    origin: "ICN",
    destination: "NRT",
    months: ["2026-10"],
    minTripDays: 2,
    maxTripDays: 2,
    departureWeekdays: [],
    returnWeekdays: [],
    ...overrides,
  };
}

describe("generateDatePairs", () => {
  it("uses inclusive trip days and allows return outside selected months", () => {
    const pairs = generateDatePairs(
      request({
        minTripDays: 5,
        maxTripDays: 5,
        departureWeekdays: [4],
        returnWeekdays: [1],
      }),
    );

    expect(pairs).toContainEqual({
      departureDate: "2026-10-01",
      returnDate: "2026-10-05",
      tripDays: 5,
    });
    expect(pairs).toContainEqual({
      departureDate: "2026-10-29",
      returnDate: "2026-11-02",
      tripDays: 5,
    });
  });

  it("applies departure and return weekday filters in UTC", () => {
    const pairs = generateDatePairs(
      request({
        minTripDays: 2,
        maxTripDays: 5,
        departureWeekdays: [5],
        returnWeekdays: [1],
      }),
    );

    expect(pairs).toEqual([
      { departureDate: "2026-10-02", returnDate: "2026-10-05", tripDays: 4 },
      { departureDate: "2026-10-09", returnDate: "2026-10-12", tripDays: 4 },
      { departureDate: "2026-10-16", returnDate: "2026-10-19", tripDays: 4 },
      { departureDate: "2026-10-23", returnDate: "2026-10-26", tripDays: 4 },
      { departureDate: "2026-10-30", returnDate: "2026-11-02", tripDays: 4 },
    ]);
  });

  it("includes February 29 in a leap year", () => {
    const pairs = generateDatePairs(
      request({
        months: ["2028-02"],
        minTripDays: 2,
        maxTripDays: 2,
      }),
    );

    expect(pairs).toHaveLength(29);
    expect(pairs).toContainEqual({
      departureDate: "2028-02-29",
      returnDate: "2028-03-01",
      tripDays: 2,
    });
  });

  it("does not include February 29 in a non-leap year", () => {
    const pairs = generateDatePairs(
      request({
        months: ["2027-02"],
        minTripDays: 2,
        maxTripDays: 2,
      }),
    );

    expect(pairs).toHaveLength(28);
    expect(pairs.some(({ departureDate }) => departureDate === "2027-02-29")).toBe(
      false,
    );
  });

  it("deduplicates repeated months and sorts by departure then return", () => {
    const pairs = generateDatePairs(
      request({
        months: ["2026-10", "2026-10"],
        minTripDays: 2,
        maxTripDays: 3,
      }),
    );

    expect(pairs).toHaveLength(62);
    expect(pairs.slice(0, 2)).toEqual([
      { departureDate: "2026-10-01", returnDate: "2026-10-02", tripDays: 2 },
      { departureDate: "2026-10-01", returnDate: "2026-10-03", tripDays: 3 },
    ]);
    expect(pairs.at(-1)).toEqual({
      departureDate: "2026-10-31",
      returnDate: "2026-11-02",
      tripDays: 3,
    });
  });
});
