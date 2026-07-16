import { chromium } from "playwright";

const urls = [
  "https://flight.naver.com/flights/international/ICN-NRT-20261008?adult=1&fareType=Y&returnDate=20261012&isDirect=true",
  "https://flight.naver.com/flights/international/ICN-NRT-20261008/20261012?adult=1&fareType=Y&isDirect=true",
  "https://flight.naver.com/flights/international/ICN-NRT-20261008-20261012?adult=1&fareType=Y&isDirect=true",
];

const browser = await chromium.launch({ headless: false, channel: "chrome" });
const page = await browser.newPage({ locale: "ko-KR" });

for (const url of urls) {
  await page.goto("https://flight.naver.com/", { waitUntil: "domcontentloaded" });
  await page.getByText("왕복", { exact: true }).first().click();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(15000);
  const text = await page.innerText("body");
  const dateLine = text.split(/\r?\n/).filter((line) => /\d{2}\.\d{2}\./.test(line)).slice(0, 4);
  const prices: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "왕복" && /^\d[\d,]*$/.test(lines[i + 1] || "")) {
      const ctx = lines.slice(Math.max(0, i - 8), i).join(" ");
      if (/직항/.test(ctx)) prices.push(Number(lines[i + 1].replaceAll(",", "")));
    }
  }
  prices.sort((a, b) => a - b);
  console.log(JSON.stringify({ url, dateLine, minPrice: prices[0] ?? null, priceCount: prices.length }));
}

await browser.close();
