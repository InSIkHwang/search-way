import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CAPTURE_ROOT = join(tmpdir(), "search-way-phase0", "naver");

const searchUrl =
  "https://flight.naver.com/flights/international/ICN-NRT-20261008?adult=1&fareType=Y&returnDate=20261012&isDirect=true";

await mkdir(CAPTURE_ROOT, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  channel: "chrome",
});
const context = await browser.newContext({
  locale: "ko-KR",
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();

const apiCalls: Array<{
  url: string;
  method: string;
  status: number;
  requestBody?: string;
  bodyPreview: string;
}> = [];

page.on("request", (request) => {
  const url = request.url();
  if (/flight-api|airline-api|graphql|searchFlights/i.test(url)) {
    apiCalls.push({
      url,
      method: request.method(),
      status: 0,
      requestBody: request.postData() ?? undefined,
      bodyPreview: "",
    });
  }
});

page.on("response", async (response) => {
  const url = response.url();
  if (!/flight-api|airline-api|graphql|searchFlights/i.test(url)) return;
  try {
    const text = await response.text();
    const entry = apiCalls.find((item) => item.url === url && item.status === 0);
    if (entry) {
      entry.status = response.status();
      entry.bodyPreview = text.slice(0, 4000);
    } else {
      apiCalls.push({
        url,
        method: response.request().method(),
        status: response.status(),
        requestBody: response.request().postData() ?? undefined,
        bodyPreview: text.slice(0, 4000),
      });
    }
  } catch {
    // ignore
  }
});

await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

for (let i = 0; i < 24; i += 1) {
  const text = await page.innerText("body");
  const hasPrice = /₩|원/.test(text) && text.length > 800;
  if (hasPrice) {
    await writeFile(join(CAPTURE_ROOT, "page-text.txt"), text, "utf8");
    break;
  }
  await page.waitForTimeout(5000);
}

const finalText = await page.innerText("body");
await writeFile(join(CAPTURE_ROOT, "candidates.json"), JSON.stringify(apiCalls, null, 2), "utf8");
await writeFile(join(CAPTURE_ROOT, "page-text-final.txt"), finalText, "utf8");

console.log(
  JSON.stringify({
    captureDir: CAPTURE_ROOT,
    apiCallCount: apiCalls.length,
    hasPrice: /₩|원/.test(finalText),
    priceMatches: [...finalText.matchAll(/₩\s*[\d,]+|[\d,]+원/g)].slice(0, 10),
    textLength: finalText.length,
  }),
);

await browser.close();
