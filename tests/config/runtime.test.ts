import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/runtime.js";

describe("loadRuntimeConfig", () => {
  it("uses documented defaults", () => {
    expect(loadRuntimeConfig({})).toEqual({
      dataDir: "./data/jobs",
      concurrencyPerSource: 5,
      minDelayMs: 500,
      maxDelayMs: 1500,
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      requestTimeoutMs: 30000,
      naverHeadless: false,
    });
  });

  it("clamps concurrency and retries", () => {
    expect(loadRuntimeConfig({
      SEARCH_WAY_PROVIDER_CONCURRENCY: "99",
      SEARCH_WAY_MAX_RETRIES: "-1",
    })).toMatchObject({
      concurrencyPerSource: 6,
      maxRetries: 0,
    });
  });

  it("rejects invalid timeout strings", () => {
    expect(() => loadRuntimeConfig({
      SEARCH_WAY_REQUEST_TIMEOUT_MS: "30s",
    })).toThrow("SEARCH_WAY_REQUEST_TIMEOUT_MS");
  });

  it("rejects invalid delay ordering", () => {
    expect(() => loadRuntimeConfig({
      SEARCH_WAY_MIN_DELAY_MS: "2000",
      SEARCH_WAY_MAX_DELAY_MS: "1000",
    })).toThrow("SEARCH_WAY_MAX_DELAY_MS");
  });

  it("clamps concurrency zero to one", () => {
    expect(loadRuntimeConfig({
      SEARCH_WAY_PROVIDER_CONCURRENCY: "0",
    }).concurrencyPerSource).toBe(1);
  });

  it("clamps retries above three", () => {
    expect(loadRuntimeConfig({
      SEARCH_WAY_MAX_RETRIES: "9",
    }).maxRetries).toBe(3);
  });

  it("accepts a custom data directory", () => {
    expect(loadRuntimeConfig({
      SEARCH_WAY_DATA_DIR: "/tmp/custom",
    }).dataDir).toBe("/tmp/custom");
  });

  it("rejects non-positive retry base delay", () => {
    expect(() => loadRuntimeConfig({
      SEARCH_WAY_RETRY_BASE_DELAY_MS: "0",
    })).toThrow("SEARCH_WAY_RETRY_BASE_DELAY_MS");
  });

  it("enables Naver headless mode from SEARCH_WAY_NAVER_HEADLESS=1", () => {
    expect(loadRuntimeConfig({
      SEARCH_WAY_NAVER_HEADLESS: "1",
    }).naverHeadless).toBe(true);
  });
});
