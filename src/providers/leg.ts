import type { FlightLeg, ParseContext } from "./types.js";

export interface ExtractedLegTimes {
  airline?: string;
  outboundDepartureTime?: string;
  outboundArrivalTime?: string;
  inboundDepartureTime?: string;
  inboundArrivalTime?: string;
}

export function buildLegs(
  context: ParseContext,
  extracted: ExtractedLegTimes,
): { outbound: FlightLeg; inbound: FlightLeg } {
  const airline = extracted.airline;
  return {
    outbound: {
      date: context.departureDate,
      ...(extracted.outboundDepartureTime === undefined
        ? {}
        : { departureTime: extracted.outboundDepartureTime }),
      ...(extracted.outboundArrivalTime === undefined
        ? {}
        : { arrivalTime: extracted.outboundArrivalTime }),
      ...(airline === undefined ? {} : { airline }),
    },
    inbound: {
      date: context.returnDate,
      ...(extracted.inboundDepartureTime === undefined
        ? {}
        : { departureTime: extracted.inboundDepartureTime }),
      ...(extracted.inboundArrivalTime === undefined
        ? {}
        : { arrivalTime: extracted.inboundArrivalTime }),
      ...(airline === undefined ? {} : { airline }),
    },
  };
}
