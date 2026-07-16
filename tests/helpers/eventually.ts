import { expect } from "vitest";

export async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  expect.fail(`eventually timed out: ${String(lastError)}`);
}
