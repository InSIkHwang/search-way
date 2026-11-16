import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCliDefaults, getMcpConfig, getUserDataDir } from "../../src/cli/config.js";

describe("설치용 CLI 설정", () => {
  it("작업 폴더와 무관한 운영체제별 사용자 저장 경로를 선택한다", () => {
    expect(getUserDataDir({ LOCALAPPDATA: "local" }, "win32", "home")).toBe(join("local", "search-way", "jobs"));
    expect(getUserDataDir({}, "darwin", "home")).toBe(join("home", "Library", "Application Support", "search-way", "jobs"));
    expect(getUserDataDir({ XDG_DATA_HOME: "xdg" }, "linux", "home")).toBe(join("xdg", "search-way", "jobs"));
    expect(getUserDataDir({}, "linux", "home")).toBe(join("home", ".local", "share", "search-way", "jobs"));
  });

  it("설치용 기본값을 적용하되 사용자가 지정한 값은 보존한다", () => {
    const defaults: NodeJS.ProcessEnv = {};
    applyCliDefaults(defaults);
    expect(defaults.SEARCH_WAY_ALLOW_LIVE_NETWORK).toBe("1");
    expect(defaults.SEARCH_WAY_NAVER_HEADLESS).toBe("1");
    expect(defaults.SEARCH_WAY_DATA_DIR).toBeTruthy();
    const custom = { SEARCH_WAY_ALLOW_LIVE_NETWORK: "0", SEARCH_WAY_NAVER_HEADLESS: "0", SEARCH_WAY_DATA_DIR: "custom" };
    applyCliDefaults(custom);
    expect(custom).toEqual({ SEARCH_WAY_ALLOW_LIVE_NETWORK: "0", SEARCH_WAY_NAVER_HEADLESS: "0", SEARCH_WAY_DATA_DIR: "custom" });
  });

  it("Windows cmd 실행과 POSIX npx 실행을 구분하고 버전을 고정한다", () => {
    expect(getMcpConfig("1.2.3", "win32").mcpServers["search-way"]).toEqual({ command: "cmd", args: ["/c", "npx", "-y", "search-way@1.2.3"] });
    expect(getMcpConfig("1.2.3", "linux").mcpServers["search-way"]).toEqual({ command: "npx", args: ["-y", "search-way@1.2.3"] });
  });
});
