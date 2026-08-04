import { buildLegs } from "../leg.js";
import { extractGoogleInboundLegCapture } from "./inbound-capture.js";
import type { ParseContext, Quote } from "../types.js";
export class GoogleParseFailure extends Error {
  constructor(
    readonly code: "no_direct_flight" | "provider_error",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GoogleParseFailure";
  }
}

interface DirectCandidate {
  stopCount: number;
  price: number;
  airline?: string;
  outboundDepartureTime?: string;
  outboundArrivalTime?: string;
}

const ROW_PATTERN =
  /<li\b(?=[^>]*\bclass="[^"]*\bpIav2d\b)[^>]*>([\s\S]*?)<\/li>/gi;

function assertIsoScrapedAt(scrapedAt: string): void {
  if (new Date(scrapedAt).toISOString() !== scrapedAt) {
    throw new GoogleParseFailure("provider_error", "Invalid scrapedAt timestamp");
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractCaptureUrl(html: string): string {
  const metaMatch = html.match(
    /<meta\s+name=["']capture-url["']\s+content=["']([^"']+)["']/i,
  );
  if (metaMatch === null) {
    throw new GoogleParseFailure("provider_error", "Missing capture URL");
  }
  const url = decodeHtmlEntities(metaMatch[1]!);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
    return url;
  } catch {
    throw new GoogleParseFailure("provider_error", "Invalid capture URL");
  }
}

function normalizeKoreanClockTime(
  period: string,
  hourText: string,
  minuteText: string,
): string {
  let hour = Number.parseInt(hourText, 10);
  if (period === "오후" && hour !== 12) {
    hour += 12;
  }
  if (period === "오전" && hour === 12) {
    hour = 0;
  }
  return `${String(hour).padStart(2, "0")}:${minuteText}`;
}

function extractKoreanClockTime(
  text: string,
  label: "출발" | "도착",
): string | undefined {
  const labeled = text.match(
    new RegExp(`${label}\\s*시간:\\s*(오전|오후)\\s*(\\d{1,2}):(\\d{2})`),
  );
  if (labeled !== null) {
    return normalizeKoreanClockTime(labeled[1]!, labeled[2]!, labeled[3]!);
  }
  return undefined;
}

function extractGoogleLegTimes(block: string): {
  outboundDepartureTime?: string;
  outboundArrivalTime?: string;
} {
  const outboundDepartureTime = extractKoreanClockTime(block, "출발");
  const outboundArrivalTime = extractKoreanClockTime(block, "도착");
  if (outboundDepartureTime !== undefined || outboundArrivalTime !== undefined) {
    return {
      ...(outboundDepartureTime === undefined
        ? {}
        : { outboundDepartureTime }),
      ...(outboundArrivalTime === undefined ? {} : { outboundArrivalTime }),
    };
  }

  const inlineMatch = block.match(
    /(오전|오후)\s*(\d{1,2}):(\d{2})[\s\S]{0,40}?(오전|오후)\s*(\d{1,2}):(\d{2})/,
  );
  if (inlineMatch === null) {
    return {};
  }
  return {
    outboundDepartureTime: normalizeKoreanClockTime(
      inlineMatch[1]!,
      inlineMatch[2]!,
      inlineMatch[3]!,
    ),
    outboundArrivalTime: normalizeKoreanClockTime(
      inlineMatch[4]!,
      inlineMatch[5]!,
      inlineMatch[6]!,
    ),
  };
}

function parseKrwPrice(block: string): number | null {
  const ariaMatch = block.match(/aria-label="[^"]*?(\d[\d,]*)\s*대한민국\s*원/i);
  if (ariaMatch !== null && ariaMatch[1] !== undefined) {
    return Number.parseInt(ariaMatch[1].replace(/,/g, ""), 10);
  }
  const visibleMatch = block.match(/₩\s*([\d,]+)/);
  if (visibleMatch !== null && visibleMatch[1] !== undefined) {
    return Number.parseInt(visibleMatch[1].replace(/,/g, ""), 10);
  }
  return null;
}

function isLegacyDirectBlock(block: string): boolean {
  const directMatch = block.match(/<span\s+class="VG3hNb"[^>]*>([^<]*)<\/span>/i);
  return directMatch !== null && directMatch[1] !== undefined && directMatch[1].trim() === "직항";
}

export function isDirectGoogleRow(block: string): boolean {
  if (isLegacyDirectBlock(block)) {
    return true;
  }
  if (/aria-label="[^"]*직항[^"]*"/i.test(block)) {
    return !/\d+\s*회\s*경유/.test(block);
  }
  if (/>\s*직항\s*</.test(block)) {
    return !/\d+\s*회\s*경유/.test(block);
  }
  return false;
}

function parseStopCount(liTag: string, block: string): number | null {
  const fromLi = liTag.match(/\bdata-stop-count="(\d+)"/i)?.[1];
  if (fromLi !== undefined) {
    return Number.parseInt(fromLi, 10);
  }
  const fromBlock = block.match(/\bdata-stop-count="(\d+)"/i)?.[1];
  if (fromBlock !== undefined) {
    return Number.parseInt(fromBlock, 10);
  }
  return isDirectGoogleRow(block) ? 0 : null;
}

function extractAirline(block: string): string | undefined {
  const ariaAirline = block.match(
    /([가-힣]+항공|[A-Za-z][A-Za-z\s]*Airlines?)\s*의\s*직항/i,
  )?.[1]?.trim();
  if (ariaAirline !== undefined && ariaAirline.length > 0) {
    return ariaAirline;
  }
  const airlineMatch = block.match(/<span\s+class="airline"[^>]*>([^<]+)<\/span>/i);
  const airline = airlineMatch?.[1]?.trim();
  return airline === "" || airline === undefined ? undefined : airline;
}

export function extractGoogleDirectCandidates(html: string): DirectCandidate[] {
  const candidates: DirectCandidate[] = [];
  for (const match of html.matchAll(ROW_PATTERN)) {
    const liTag = match[0];
    const block = match[1];
    if (block === undefined) {
      continue;
    }
    const stopCount = parseStopCount(liTag, block);
    if (stopCount === null || stopCount !== 0 || !isDirectGoogleRow(block)) {
      continue;
    }
    const price = parseKrwPrice(block);
    if (price === null || !Number.isSafeInteger(price) || price <= 0) {
      continue;
    }
    const airline = extractAirline(block);
    const legTimes = extractGoogleLegTimes(block);
    candidates.push({
      stopCount,
      price,
      ...(airline === undefined ? {} : { airline }),
      ...legTimes,
    });
  }
  return candidates;
}

export function isGoogleResultsReady(html: string): boolean {
  return extractGoogleDirectCandidates(html).length > 0;
}

function matchesAirline(candidate: DirectCandidate, airline: string): boolean {
  if (candidate.airline === undefined) {
    return false;
  }
  const normalize = (value: string) => value.replace(/\s+/g, "").toLowerCase();
  return normalize(candidate.airline).includes(normalize(airline));
}

export function parseGoogleDirectRoundTrip(
  body: string,
  scrapedAt: string,
  airline?: string,
  context?: ParseContext,
): Quote {
  assertIsoScrapedAt(scrapedAt);

  const allCandidates = extractGoogleDirectCandidates(body);
  if (allCandidates.length === 0) {
    if (/<li\b[^>]*\bclass="[^"]*\bpIav2d\b/i.test(body)) {
      throw new GoogleParseFailure("no_direct_flight", "No direct round-trip flights found");
    }
    throw new GoogleParseFailure("provider_error", "Malformed Google response");
  }

  const candidates =
    airline === undefined
      ? allCandidates
      : allCandidates.filter((candidate) => matchesAirline(candidate, airline));
  if (candidates.length === 0) {
    throw new GoogleParseFailure(
      "no_direct_flight",
      `No direct round-trip flights found for airline ${airline}`,
    );
  }

  const lowest = candidates.reduce((best, current) =>
    current.price < best.price ? current : best,
  );
  const url = extractCaptureUrl(body);
  const inboundCapture = extractGoogleInboundLegCapture(body);
  const legs =
    context === undefined
      ? {}
      : buildLegs(context, {
          ...(lowest.airline === undefined ? {} : { airline: lowest.airline }),
          ...(lowest.outboundDepartureTime === undefined
            ? {}
            : { outboundDepartureTime: lowest.outboundDepartureTime }),
          ...(lowest.outboundArrivalTime === undefined
            ? {}
            : { outboundArrivalTime: lowest.outboundArrivalTime }),
          ...(inboundCapture?.departureTime === undefined
            ? {}
            : { inboundDepartureTime: inboundCapture.departureTime }),
          ...(inboundCapture?.arrivalTime === undefined
            ? {}
            : { inboundArrivalTime: inboundCapture.arrivalTime }),
        });
  return {
    price: lowest.price,
    currency: "KRW",
    url,
    scrapedAt,
    ...(lowest.airline === undefined ? {} : { airline: lowest.airline }),
    ...legs,
  };
}
