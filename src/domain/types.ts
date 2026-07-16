export interface FlexibleSearchRequest {
  origin: string;
  destination: string;
  months: string[];
  minTripDays: number;
  maxTripDays: number;
  departureWeekdays: number[];
  returnWeekdays: number[];
  airline?: string;
}

export interface DatePair {
  departureDate: string;
  returnDate: string;
  tripDays: number;
}
