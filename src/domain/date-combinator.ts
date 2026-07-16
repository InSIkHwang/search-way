import type { DatePair, FlexibleSearchRequest } from "./types.js";

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseMonth(month: string): { year: number; monthIndex: number } {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) {
    throw new Error(`Invalid month: ${month}`);
  }

  return {
    year: Number(match[1]),
    monthIndex: Number(match[2]) - 1,
  };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function generateDatePairs(
  request: FlexibleSearchRequest,
): DatePair[] {
  const departureWeekdays = new Set(request.departureWeekdays);
  const returnWeekdays = new Set(request.returnWeekdays);
  const pairs = new Map<string, DatePair>();

  for (const month of [...new Set(request.months)].sort()) {
    const { year, monthIndex } = parseMonth(month);
    const daysInMonth = new Date(
      Date.UTC(year, monthIndex + 1, 0),
    ).getUTCDate();

    for (let day = 1; day <= daysInMonth; day += 1) {
      const departure = new Date(Date.UTC(year, monthIndex, day));
      if (
        departureWeekdays.size > 0 &&
        !departureWeekdays.has(departure.getUTCDay())
      ) {
        continue;
      }

      for (
        let tripDays = request.minTripDays;
        tripDays <= request.maxTripDays;
        tripDays += 1
      ) {
        const returnDate = new Date(
          departure.getTime() + (tripDays - 1) * DAY_MS,
        );
        if (
          returnWeekdays.size > 0 &&
          !returnWeekdays.has(returnDate.getUTCDay())
        ) {
          continue;
        }

        const pair: DatePair = {
          departureDate: formatDate(departure),
          returnDate: formatDate(returnDate),
          tripDays,
        };
        pairs.set(`${pair.departureDate}/${pair.returnDate}`, pair);
      }
    }
  }

  return [...pairs.values()].sort(
    (left, right) =>
      left.departureDate.localeCompare(right.departureDate) ||
      left.returnDate.localeCompare(right.returnDate),
  );
}
