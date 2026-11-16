import { homedir } from "node:os";
import { join } from "node:path";

export function getUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  const base = platform === "win32"
    ? env.LOCALAPPDATA || join(home, "AppData", "Local")
    : platform === "darwin"
      ? join(home, "Library", "Application Support")
      : env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(base, "search-way", "jobs");
}

export function applyCliDefaults(env: NodeJS.ProcessEnv): void {
  env.SEARCH_WAY_ALLOW_LIVE_NETWORK ??= "1";
  env.SEARCH_WAY_NAVER_HEADLESS ??= "1";
  env.SEARCH_WAY_DATA_DIR ||= getUserDataDir(env);
}

export function getMcpConfig(version: string, platform = process.platform) {
  const args = ["-y", `search-way@${version}`];
  return {
    mcpServers: {
      "search-way": platform === "win32"
        ? { command: "cmd", args: ["/c", "npx", ...args] }
        : { command: "npx", args },
    },
  };
}
