import { describe, expect, it, vi } from "vitest";
import { setupBrowsers } from "../../src/cli/setup.js";

describe("검색용 브라우저 준비", () => {
  it("이미 설치된 Chrome은 설치 명령으로 교체하지 않는다", async () => {
    const install = vi.fn(async () => {});
    await setupBrowsers(false, { install, checkChrome: async () => {}, log: () => {} });
    expect(install.mock.calls).toEqual([["chromium", false]]);
  });

  it("Chrome이 없을 때만 설치하고 설치 후 실행을 확인한다", async () => {
    const install = vi.fn(async () => {});
    const checkChrome = vi.fn().mockRejectedValueOnce(new Error("Chromium distribution 'chrome' is not found at location")).mockResolvedValueOnce(undefined);
    await setupBrowsers(true, { install, checkChrome, log: () => {} });
    expect(install.mock.calls).toEqual([["chromium", true], ["chrome", true]]);
    expect(checkChrome).toHaveBeenCalledTimes(2);
  });

  it("Chrome 실행 권한 오류가 나면 재설치로 우회하지 않는다", async () => {
    const install = vi.fn(async () => {});
    await expect(setupBrowsers(false, { install, checkChrome: async () => { throw new Error("permission denied"); }, log: () => {} })).rejects.toThrow("permission denied");
    expect(install.mock.calls).toEqual([["chromium", false]]);
  });

  it("브라우저 다운로드 실패를 숨기지 않는다", async () => {
    const checkChrome = vi.fn();
    await expect(setupBrowsers(false, { install: async () => { throw new Error("download failed"); }, checkChrome, log: () => {} })).rejects.toThrow("download failed");
    expect(checkChrome).not.toHaveBeenCalled();
  });
});
