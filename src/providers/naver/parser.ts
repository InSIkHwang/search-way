import type { Quote } from "../types.js";



export class NaverParseFailure extends Error {

  constructor(

    readonly code: "no_direct_flight" | "provider_error",

    message: string,

    options?: ErrorOptions,

  ) {

    super(message, options);

    this.name = "NaverParseFailure";

  }

}



const ROUND_TRIP_MARKER = "왕복";

const DIRECT_TEXT = "직항";

const CURRENCY_SUFFIX = "원";



interface DirectCandidate {

  price: number;

  airline?: string;

}



function assertIsoScrapedAt(scrapedAt: string): void {

  if (new Date(scrapedAt).toISOString() !== scrapedAt) {

    throw new NaverParseFailure("provider_error", "Invalid scrapedAt timestamp");

  }

}



function decodeHtmlEntities(value: string): string {

  return value

    .replace(/&amp;/g, "&")

    .replace(/&quot;/g, '"')

    .replace(/&#39;/g, "'");

}



function extractBodyText(html: string): string {

  const preMatch = html.match(/<pre\s+id=["']body-text["'][^>]*>([\s\S]*?)<\/pre>/i);

  const bodyText = preMatch?.[1]?.trim();

  if (bodyText === undefined || bodyText.length === 0) {

    throw new NaverParseFailure("provider_error", "Malformed Naver response");

  }

  return bodyText;

}



function extractCaptureUrl(html: string): string {

  const metaMatch = html.match(

    /<meta\s+name=["']capture-url["']\s+content=["']([^"']+)["']/i,

  );

  if (metaMatch === null) {

    throw new NaverParseFailure("provider_error", "Missing capture URL");

  }

  const url = decodeHtmlEntities(metaMatch[1]!);

  try {

    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {

      throw new Error("invalid protocol");

    }

    return url;

  } catch {

    throw new NaverParseFailure("provider_error", "Invalid capture URL");

  }

}



function extractAirlineFromContextLines(contextLines: readonly string[]): string | undefined {

  for (let index = contextLines.length - 1; index >= 0; index -= 1) {

    const line = contextLines[index]?.trim() ?? "";

    if (line.length === 0 || line.includes("네이버")) {

      continue;

    }

    if (/항공$/.test(line) || /Airlines?$/i.test(line)) {

      return line;

    }

  }

  return undefined;

}



function extractDirectCandidates(bodyText: string): DirectCandidate[] {

  const lines = bodyText.split(/\r?\n/);

  const candidates: DirectCandidate[] = [];



  for (let index = 0; index < lines.length; index += 1) {

    const line = lines[index];

    const nextLine = lines[index + 1] ?? "";

    const suffixLine = lines[index + 2] ?? "";

    if (

      line !== ROUND_TRIP_MARKER ||

      !/^\d[\d,]*$/.test(nextLine) ||

      !suffixLine.startsWith(CURRENCY_SUFFIX)

    ) {

      continue;

    }



    const contextLines = lines.slice(Math.max(0, index - 8), index);

    const context = contextLines.join(" ");

    if (!context.includes(DIRECT_TEXT)) {

      continue;

    }



    const price = Number.parseInt(nextLine.replace(/,/g, ""), 10);

    const airline = extractAirlineFromContextLines(contextLines);

    candidates.push(

      airline === undefined ? { price } : { price, airline },

    );

  }



  return candidates;

}



function matchesAirline(candidate: DirectCandidate, airline: string): boolean {

  if (candidate.airline === undefined) {

    return false;

  }

  const normalize = (value: string) => value.replace(/\s+/g, "").toLowerCase();

  return normalize(candidate.airline).includes(normalize(airline));

}



export function parseNaverDirectRoundTrip(

  body: string,

  scrapedAt: string,

  airline?: string,

): Quote {

  assertIsoScrapedAt(scrapedAt);

  const bodyText = extractBodyText(body);

  const allCandidates = extractDirectCandidates(bodyText);



  if (allCandidates.length === 0) {

    if (bodyText.includes(ROUND_TRIP_MARKER)) {

      throw new NaverParseFailure("no_direct_flight", "No direct round-trip flights found");

    }

    throw new NaverParseFailure("provider_error", "Malformed Naver response");

  }



  const candidates =

    airline === undefined

      ? allCandidates

      : allCandidates.filter((candidate) => matchesAirline(candidate, airline));

  if (candidates.length === 0) {

    throw new NaverParseFailure(

      "no_direct_flight",

      `No direct round-trip flights found for airline ${airline}`,

    );

  }



  const lowest = candidates.reduce((best, current) =>

    current.price < best.price ? current : best,

  );

  if (!Number.isSafeInteger(lowest.price) || lowest.price <= 0) {

    throw new NaverParseFailure("provider_error", "Invalid KRW price");

  }



  const url = extractCaptureUrl(body);

  return {

    price: lowest.price,

    currency: "KRW",

    url,

    scrapedAt,

    ...(lowest.airline === undefined ? {} : { airline: lowest.airline }),

  };

}


