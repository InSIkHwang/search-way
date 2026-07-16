import { readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";

interface CanonicalSearchCase {
  origin: string;
  destination: string;
  departure_date: string;
  return_date: string;
  adults: 1;
  cabin: "economy";
  trip_type: "round_trip";
  nonstop: true;
}

interface UrlRecipeUnavailable {
  status: "unavailable";
  reason: string;
  evidence: string[];
}

interface UrlRecipeVerified {
  status: "verified";
  url_origin: string;
  pathname_recipe: string;
  bindings: Record<string, unknown>;
  example_url: string;
  evidence: string[];
}

type UrlRecipe = UrlRecipeUnavailable | UrlRecipeVerified;

interface PlaywrightLaunchProfile {
  headless: boolean;
  channel?: "chrome";
}

interface PlaywrightPageProfile {
  url: string;
  readyText: string;
  roundTripMarker: string;
  directText: string;
  currencySuffix: string;
  dateMarkers: string[];
  launch: PlaywrightLaunchProfile;
}

interface PlaywrightSpikeProfile {
  provider: "naver";
  mode: "playwright";
  final_case: CanonicalSearchCase;
  url_recipe: UrlRecipe;
  page: PlaywrightPageProfile;
  sample: {
    directText: string;
    priceText: string;
    href: string;
  };
}

interface SpikeOutput {
  provider: "naver";
  attempt: 1 | 2 | 3;
  mode: "http" | "playwright";
  origin: string;
  destination: string;
  departureDate: string;
  returnDate: string;
  direct: true;
  price: number;
  currency: "KRW";
  url: string;
  observedAt: string;
}

const OFFICIAL_URL_PATTERN = /^https:\/\/([^.]+\.)*naver\.com\//;
const TIMEOUT_MS = 120_000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  profilePath: string;
  attempt: 1 | 2 | 3;
  offline: boolean;
} {
  let profilePath = "";
  let attempt: 1 | 2 | 3 | null = null;
  let offline = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      profilePath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--attempt") {
      const value = Number(argv[index + 1]);
      if (value === 1 || value === 2 || value === 3) {
        attempt = value;
      }
      index += 1;
      continue;
    }
    if (arg === "--offline") {
      offline = true;
    }
  }

  if (profilePath === "" || attempt === null) {
    fail("Usage: spike-naver --profile <path> --attempt <1|2|3> [--offline]");
  }

  return { profilePath, attempt, offline };
}

function loadProfile(profilePath: string): PlaywrightSpikeProfile {
  const raw = readFileSync(profilePath, "utf8");
  const profile = JSON.parse(raw) as PlaywrightSpikeProfile;

  if (profile.provider !== "naver" || profile.mode !== "playwright") {
    fail("Profile must be a Naver Playwright spike profile");
  }

  if (
    profile.final_case.adults !== 1 ||
    profile.final_case.cabin !== "economy" ||
    profile.final_case.trip_type !== "round_trip" ||
    profile.final_case.nonstop !== true
  ) {
    fail("Profile final_case does not match the canonical Naver spike contract");
  }

  return profile;
}

function parsePriceText(priceText: string): number {
  const match = priceText.match(/(\d[\d,]*)/);
  if (match === null) {
    fail(`Unable to parse KRW price from: ${priceText}`);
  }
  const price = Number.parseInt(match[1].replace(/,/g, ""), 10);
  if (!Number.isInteger(price) || price <= 0) {
    fail(`Parsed price is not a positive integer: ${price}`);
  }
  return price;
}

function assertOfficialUrl(url: string): void {
  if (!OFFICIAL_URL_PATTERN.test(url)) {
    fail(`URL is not an official Naver HTTPS origin: ${url}`);
  }
}

function extractLowestDirectRoundTripPrice(
  bodyText: string,
  profile: PlaywrightSpikeProfile,
): number {
  const lines = bodyText.split(/\r?\n/);
  const prices: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1] ?? "";
    const suffixLine = lines[index + 2] ?? "";
    if (
      line !== profile.page.roundTripMarker ||
      !/^\d[\d,]*$/.test(nextLine) ||
      !suffixLine.startsWith(profile.page.currencySuffix)
    ) {
      continue;
    }

    const context = lines.slice(Math.max(0, index - 8), index).join(" ");
    if (!context.includes(profile.page.directText)) {
      continue;
    }

    prices.push(Number.parseInt(nextLine.replace(/,/g, ""), 10));
  }

  if (prices.length === 0) {
    fail("No direct round-trip KRW price rows found in Naver body text");
  }

  return Math.min(...prices);
}

function assertCapturedDates(bodyText: string, profile: PlaywrightSpikeProfile): void {
  for (const marker of profile.page.dateMarkers) {
    if (!bodyText.includes(marker)) {
      fail(`Expected captured date marker missing from Naver body text: ${marker}`);
    }
  }
}

function buildOutput(
  profile: PlaywrightSpikeProfile,
  attempt: 1 | 2 | 3,
  price: number,
  url: string,
): SpikeOutput {
  assertOfficialUrl(url);

  return {
    provider: "naver",
    attempt,
    mode: "playwright",
    origin: profile.final_case.origin,
    destination: profile.final_case.destination,
    departureDate: profile.final_case.departure_date,
    returnDate: profile.final_case.return_date,
    direct: true,
    price,
    currency: "KRW",
    url,
    observedAt: new Date().toISOString(),
  };
}

async function extractLive(
  profile: PlaywrightSpikeProfile,
  attempt: 1 | 2 | 3,
): Promise<SpikeOutput> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: profile.page.launch.headless,
      channel: profile.page.launch.channel,
    });
    const context = await browser.newContext({
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.goto(profile.page.url, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_MS,
    });

    let bodyText = "";
    for (let waitIndex = 0; waitIndex < 24; waitIndex += 1) {
      bodyText = await page.innerText("body");
      const hasReadyState =
        bodyText.includes(profile.page.readyText) &&
        bodyText.includes(profile.page.roundTripMarker) &&
        /[\d,]+원/.test(bodyText) &&
        !/편도 항공편 선택/.test(bodyText);
      if (hasReadyState) {
        break;
      }
      await page.waitForTimeout(5_000);
    }

    if (
      !bodyText.includes(profile.page.readyText) ||
      !bodyText.includes(profile.page.roundTripMarker)
    ) {
      fail("Naver results page did not reach the captured ready state");
    }

    assertCapturedDates(bodyText, profile);
    const price = extractLowestDirectRoundTripPrice(bodyText, profile);
    const href = page.url();
    return buildOutput(profile, attempt, price, href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Live Playwright extraction failed: ${message}`);
  } finally {
    if (browser !== null) {
      await browser.close();
    }
  }
}

async function main(): Promise<void> {
  const { profilePath, attempt, offline } = parseArgs(process.argv.slice(2));
  const profile = loadProfile(profilePath);

  const output = offline
    ? buildOutput(
        profile,
        attempt,
        parsePriceText(profile.sample.priceText),
        profile.sample.href,
      )
    : await extractLive(profile, attempt);

  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Unhandled Naver spike error: ${message}`);
});
