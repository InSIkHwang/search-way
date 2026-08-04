import { describe, expect, it } from "vitest";
import {
  extractGoogleInboundLegCapture,
  injectGoogleInboundLeg,
} from "../../../src/providers/google/inbound-capture.js";

describe("google inbound capture helpers", () => {
  it("round-trips inbound leg JSON through the capture HTML block", () => {
    const html = injectGoogleInboundLeg(
      "<!DOCTYPE html><html><body><ul></ul></body></html>",
      { departureTime: "00:50", arrivalTime: "07:10" },
    );

    expect(extractGoogleInboundLegCapture(html)).toEqual({
      departureTime: "00:50",
      arrivalTime: "07:10",
    });
  });
});
