import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CAPTURE_ROOT = join(tmpdir(), "search-way-phase0", "naver");
await mkdir(CAPTURE_ROOT, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  channel: "chrome",
});
const page = await browser.newPage({
  locale: "ko-KR",
  viewport: { width: 1440, height: 900 },
});

const apiCalls: Array<{
  url: string;
  method: string;
  status: number;
  requestBody?: string;
  bodyPreview: string;
}> = [];

page.on("response", async (response) => {
  const url = response.url();
  if (!/flight-api\.naver\.com\/flight\/international\/searchFlights/.test(url)) {
    return;
  }
  try {
    apiCalls.push({
      url,
      method: response.request().method(),
      status: response.status(),
      requestBody: response.request().postData() ?? undefined,
      bodyPreview: (await response.text()).slice(0, 6000),
    });
  } catch {
    // ignore
  }
});

await page.goto("https://flight.naver.com/", {
  waitUntil: "domcontentloaded",
  timeout: 120_000,
});

await page.getByText("왕복", { exact: true }).first().click();
await page.waitForTimeout(1000);

const searchUrl =
  "https://flight.naver.com/flights/international/ICN-NRT-20261008?adult=1&fareType=Y&returnDate=20261012&isDirect=true";

await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

for (let i = 0; i < 24; i += 1) {
  const text = await page.innerText("body");
  const hasRoundTrip =
    /왕복/.test(text) &&
    /직항/.test(text) &&
    /[\d,]+원/.test(text) &&
    !/편도 항공편 선택/.test(text);
  if (hasRoundTrip) break;
  await page.waitForTimeout(5000);
}

const finalText = await page.innerText("body");
await writeFile(join(CAPTURE_ROOT, "rt-candidates.json"), JSON.stringify(apiCalls, null, 2), "utf8");
await writeFile(join(CAPTURE_ROOT, "rt-page-text.txt"), finalText, "utf8");

console.log(
  JSON.stringify({
    apiCallCount: apiCalls.length,
    tripTypes: apiCalls.map((call) => {
      try {
        const body = JSON.parse(call.requestBody ?? "{}");
        return body.tripType;
      } catch {
        return null;
      }
    }),
    hasRoundTripMarker: /왕복/.test(finalText) && !/편도 항공편 선택/.test(finalText),
    priceMatches: [...finalText.matchAll(/([\d,]+)원/g)].slice(0, 15),
    directPrices: [...finalText.matchAll(/최저가[\s\S]{0,120}?([\d,]+)원/g)],
  }),
);

await browser.close();
