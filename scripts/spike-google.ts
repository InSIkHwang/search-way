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

interface PlaywrightPageProfile {
  url: string;
  readySelector: string;
  rowSelector: string;
  directSelector: string;
  directText: string;
  priceSelector: string;
  currencyToken: string;
  linkSelector: string;
}

interface PlaywrightSpikeProfile {
  provider: "google";
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
  provider: "google";
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

const OFFICIAL_URL_PATTERN = /^https:\/\/([^.]+\.)*google\.com\//;
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
    fail("Usage: spike-google --profile <path> --attempt <1|2|3> [--offline]");
  }

  return { profilePath, attempt, offline };
}

function loadProfile(profilePath: string): PlaywrightSpikeProfile {
  const raw = readFileSync(profilePath, "utf8");
  const profile = JSON.parse(raw) as PlaywrightSpikeProfile;

  if (profile.provider !== "google" || profile.mode !== "playwright") {
    fail("Profile must be a Google Playwright spike profile");
  }

  if (
    profile.final_case.adults !== 1 ||
    profile.final_case.cabin !== "economy" ||
    profile.final_case.trip_type !== "round_trip" ||
    profile.final_case.nonstop !== true
  ) {
    fail("Profile final_case does not match the canonical Google spike contract");
  }

  return profile;
}

function parsePriceText(priceText: string): number {
  const match = priceText.match(/₩\s*([\d,]+)/);
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
    fail(`URL is not an official Google HTTPS origin: ${url}`);
  }
}

function buildOutput(
  profile: PlaywrightSpikeProfile,
  attempt: 1 | 2 | 3,
  directText: string,
  priceText: string,
  url: string,
): SpikeOutput {
  if (directText.trim() !== profile.page.directText) {
    fail(`Direct marker mismatch: expected ${profile.page.directText}, got ${directText}`);
  }

  if (!priceText.includes("₩") && !priceText.includes(profile.page.currencyToken)) {
    fail(`Price text missing KRW marker: ${priceText}`);
  }

  assertOfficialUrl(url);

  return {
    provider: "google",
    attempt,
    mode: "playwright",
    origin: profile.final_case.origin,
    destination: profile.final_case.destination,
    departureDate: profile.final_case.departure_date,
    returnDate: profile.final_case.return_date,
    direct: true,
    price: parsePriceText(priceText),
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
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(profile.page.url, {
      waitUntil: "networkidle",
      timeout: TIMEOUT_MS,
    });
    await page.waitForSelector(profile.page.readySelector, { timeout: TIMEOUT_MS });
    await page.waitForTimeout(3_000);

    const rows = page.locator(profile.page.rowSelector);
    const rowCount = await rows.count();
    if (rowCount === 0) {
      fail("No flight rows found in live Google results");
    }

    let matchedDirectText = "";
    let matchedPriceText = "";
    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      const rowText = (await row.innerText()).replace(/\s+/g, " ").trim();
      const directLocator = row.locator(profile.page.directSelector);
      const directText = (await directLocator.first().innerText().catch(() => "")).trim();
      const effectiveDirect =
        directText !== ""
          ? directText
          : rowText.includes(profile.page.directText)
            ? profile.page.directText
            : "";
      if (effectiveDirect !== profile.page.directText) {
        continue;
      }

      const priceLocator = row.locator(profile.page.priceSelector);
      const priceCount = await priceLocator.count();
      for (let priceIndex = 0; priceIndex < priceCount; priceIndex += 1) {
        const ariaLabel = await priceLocator.nth(priceIndex).getAttribute("aria-label");
        const visibleText = await priceLocator.nth(priceIndex).innerText().catch(() => "");
        const candidate = ariaLabel ?? visibleText;
        if (candidate.includes(profile.page.currencyToken) || /₩\s*[\d,]+/.test(candidate)) {
          matchedDirectText = profile.page.directText;
          matchedPriceText = /₩\s*[\d,]+/.test(visibleText)
            ? visibleText
            : `₩${ariaLabel?.match(/(\d[\d,]*)/)?.[1] ?? ""}`;
          break;
        }
      }

      if (matchedPriceText === "") {
        const priceMatch = rowText.match(/₩\s*[\d,]+/);
        if (priceMatch !== null) {
          matchedDirectText = profile.page.directText;
          matchedPriceText = priceMatch[0];
        }
      }

      if (matchedDirectText !== "" && matchedPriceText !== "") {
        break;
      }
    }

    if (matchedDirectText === "" || matchedPriceText === "") {
      fail("No direct flight row with KRW price found in live Google results");
    }

    const href = page.url();
    assertOfficialUrl(href);
    return buildOutput(profile, attempt, matchedDirectText, matchedPriceText, href);
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
        profile.sample.directText,
        profile.sample.priceText,
        profile.sample.href,
      )
    : await extractLive(profile, attempt);

  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Unhandled Google spike error: ${message}`);
});
