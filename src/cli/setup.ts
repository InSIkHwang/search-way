import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

export interface SetupDependencies {
  install(browser: "chromium" | "chrome", withDeps: boolean): Promise<void>;
  checkChrome(): Promise<void>;
  log(message: string): void;
}

function installBrowser(browser: "chromium" | "chrome", withDeps: boolean): Promise<void> {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", ...(withDeps ? ["--with-deps"] : []), browser], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${browser} 설치 실패 (종료 코드: ${code})`));
    });
  });
}

export async function setupBrowsers(
  withDeps = false,
  deps: SetupDependencies = {
    install: installBrowser,
    checkChrome: async () => {
      const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 15000 });
      await browser.close();
    },
    log: console.error,
  },
): Promise<void> {
  deps.log("Google 항공편 검색용 Chromium을 준비합니다.");
  await deps.install("chromium", withDeps);
  try {
    await deps.checkChrome();
  } catch (error) {
    // Only install when Playwright explicitly reports a missing browser. Do not
    // replace an existing Chrome installation on launch or permission failures.
    if (!(error instanceof Error) || !/distribution 'chrome' is not found/i.test(error.message)) {
      throw error;
    }
    deps.log("네이버 항공편 검색용 Google Chrome을 설치합니다. 관리자 권한이 필요할 수 있습니다.");
    await deps.install("chrome", withDeps);
    await deps.checkChrome();
  }
  deps.log("브라우저 준비가 완료됐습니다.");
}
