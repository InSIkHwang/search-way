import { beforeEach, vi } from "vitest";

beforeEach(() => {
  if (process.env.SEARCH_WAY_ALLOW_LIVE_NETWORK === "1") return;

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error(
        "Live network is disabled in tests; inject a fetch/browser fake or set SEARCH_WAY_ALLOW_LIVE_NETWORK=1 for a manual-only test",
      );
    }),
  );
});
