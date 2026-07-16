# Flexible Flight Search Phase 4 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 출처별 결정적 retry/backoff/pause, 안정적인 오류 분류, 조건을 재현하는 검색 URL, 재시작·스토어 장애 처리, 안전한 운영 기본값을 TDD로 완성한다.

**Architecture:** Phase 1의 `ExecutionToken`, `SourceScheduler.add(task, token)`, `SourceLimiterHooks`를 유지하면서 optional scheduler injection을 추가해 모든 job이 source별 scheduler를 공유한다. HTTP 또는 Playwright captured-network mode가 실제 response status/header API를 제공할 때만 429 metadata를 전달하고, DOM-only mode의 CAPTCHA/interstitial은 status 없는 영구 `provider_blocked`로 분류한다. Runtime config는 MCP production wiring과 provider timeout에 주입하며 URL 개선은 exact Phase 0 recipe가 있을 때만 별도 addendum로 재계획한다.

**Tech Stack:** Node.js 20+, TypeScript, Vitest, JSON fixture, 기존 Phase 1 orchestrator/job store, 기존 Phase 2 Google/Naver provider

---

## Ownership

Phase 4 구현 작업자는 아래 파일만 수정하거나 생성할 수 있다.

- Create: `src/orchestrator/error-taxonomy.ts`
- Modify: `src/orchestrator/config.ts`
- Modify: `src/orchestrator/queue.ts`
- Modify: `src/orchestrator/index.ts`
- Modify: `src/jobs/store.ts`
- Create: `src/config/runtime.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/providers/google/client.ts`
- Modify: `src/providers/google/provider.ts`
- Modify: `src/providers/naver/client.ts`
- Modify: `src/providers/naver/provider.ts`
- Create: `tests/config/runtime.test.ts`
- Create: `tests/mcp/runtime-wiring.test.ts`
- Create: `tests/orchestrator/retry-policy.test.ts`
- Create: `tests/orchestrator/error-taxonomy.test.ts`
- Create: `tests/orchestrator/source-pause.test.ts`
- Create: `tests/jobs/recovery.test.ts`
- Create: `tests/jobs/store-errors.test.ts`
- Create: `tests/providers/google/error-metadata.test.ts`
- Create: `tests/providers/google/timeout.test.ts`
- Create: `tests/providers/naver/error-metadata.test.ts`
- Create: `tests/providers/naver/timeout.test.ts`
- Modify: `.env.example`
- Create or Modify: `README.md`
- Conditional replan output: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase4-google-url-addendum.md`
- Conditional replan output: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase4-naver-url-addendum.md`

## Forbidden Writes

- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- `src/domain/**`
- `src/providers/types.ts`
- `src/jobs/types.ts`
- `src/domain/date-combinator.ts`
- `src/mcp/**` except `src/mcp/server.ts`
- Phase 0 spike scripts와 findings 문서
- 기존 Phase 1/2/3 테스트
- 이 계획에 열거되지 않은 모든 파일

공유 계약 변경이 필요하면 `src/providers/types.ts` 또는 `src/jobs/types.ts`를 직접 수정하지 않는다. 구현 보고서에 `INTEGRATION CONTRACT CHANGE`, 충돌한 현재 타입, 요청하는 완전한 대체 타입 정의를 기록하고 `BLOCKED`로 반환한다.

## Dependencies

- `docs/superpowers/specs/2026-07-14-flexible-flight-search-design.md`
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-contracts.md`
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-master.md`
- Phase 1 exit gate 통과: orchestrator 인스턴스 전체 job이 공유하는 source scheduler, partial result, cancellation/runtime token, atomic JSON store, startup recovery
- Phase 1 시작 계약은 `queue.ts`가 `ExecutionToken`, `SourceSchedulerOptions`, `SourceScheduler`를 export하고 `SourceScheduler.add(task, token)`을 제공하는 형태다. `createSearchOrchestrator`는 scheduler 미주입 시 factory scope에서 Google/Naver pair를 한 번 만들며 모든 job이 공유한다. Phase 4는 `OrchestratorDependencies.schedulers?: SourceSchedulers`만 additive로 추가하고 production server는 한 pair를 명시적으로 주입한다.
- Phase 2 exit gate 통과: Google/Naver fixture parser와 실제 `FlightProvider` 구현
- Phase 3 exit gate 통과: 세 MCP tool과 snake_case response smoke
- Phase 0 findings에서 확정한 Google/Naver 검색 URL 형식. findings가 이 문서의 정확한 source URL을 증명하지 않으면 shared contract 변경으로 오인하지 않고 해당 URL task를 `BLOCKED`로 보고한다.

## Exact Phase 1/2 Modify Range

Phase 1/2 계획에 고정된 실제 파일과 공개 API를 기준으로 아래 범위만 수정한다. 구현 파일이 이 계획과 다르면 임의의 대체 파일을 수정하지 않고 통합 담당자에게 불일치를 보고한다.

| Origin | File | Allowed modify range | Must remain unchanged |
|---|---|---|---|
| Phase 1 | `src/orchestrator/config.ts` | 기존 `SourceLimiterHooks` 유지, `retryBaseDelayMs` additive field와 retry policy 기본값/validation 추가 | 기존 이름/signature, concurrency/jitter/runtime retention |
| Phase 1 | `src/orchestrator/queue.ts` | 기존 `ExecutionToken.shouldStop()`, `add(task, token)`, `SourceLimiterHooks`를 유지하며 options에 `now`, `retryBaseDelayMs` 추가; shared pause/retry 구현 | FIFO, `QueueOutcome`, source 간 상태 격리 |
| Phase 1 | `src/orchestrator/index.ts` | `OrchestratorDependencies.schedulers?: SourceSchedulers`만 additive로 추가, 미주입 factory-scope fallback 유지, queue failure→`JobError`, runtime token/store catch | 기존 caller 호환, pair barrier, merge/progress, cancellation 의미 |
| Phase 1 | `src/jobs/store.ts` | atomic write/read/parse 오류를 `JobStoreError`로 감싸는 경계와 기존 `markInterrupted()` | JSON schema, temp-file→rename 원자성, clone, per-job Promise chain |
| Phase 2 | `src/providers/google/client.ts` | selected HTTP/captured-network mode가 실제 제공하는 status/`Retry-After`; DOM-only면 기존 CAPTCHA/interstitial 차단과 AbortSignal만 | findings가 고정한 endpoint/browser action/filter |
| Phase 2 | `src/providers/google/provider.ts` | 관찰된 client metadata만 source-local `ProviderFailure`에 전달; DOM-only blocked에는 status를 만들지 않음; timeout controller | parser 및 성공 `Quote.url` |
| Phase 2 | `src/providers/naver/client.ts` | Google과 동일한 mode gate를 Naver findings에 독립 적용 | findings가 고정한 수집 방식 |
| Phase 2 | `src/providers/naver/provider.ts` | 관찰된 metadata/DOM-only blocked/timeout 경계 | parser 및 성공 `Quote.url` |
| Runtime | `src/config/runtime.ts` | env 기본값, strict integer parsing, clamping, cross-field validation | provider/orchestrator construction |
| Phase 3 | `src/mcp/server.ts` | runtime config load, global source scheduler 2개 생성, provider timeout과 orchestrator wiring | MCP tool registration/serialization |

새 테스트는 기존 테스트를 덮어쓰지 않고 정확히 다음 경로에 추가한다.

```text
tests/orchestrator/retry-policy.test.ts
tests/orchestrator/error-taxonomy.test.ts
tests/orchestrator/source-pause.test.ts
tests/jobs/recovery.test.ts
tests/jobs/store-errors.test.ts
tests/providers/google/error-metadata.test.ts
tests/providers/google/timeout.test.ts
tests/providers/naver/error-metadata.test.ts
tests/providers/naver/timeout.test.ts
tests/config/runtime.test.ts
tests/mcp/runtime-wiring.test.ts
```

## Contract

### Existing shared contract

- `FlightProvider.findDirectRoundTrip(input)`은 성공 시 `Quote`, 실패 시 `unknown`을 throw한다.
- 공개 오류 코드는 기존 `JobErrorCode`의 `"provider_timeout" | "provider_blocked" | "no_direct_flight" | "currency_mismatch" | "provider_error"`만 사용한다.
- process restart와 disk/store failure는 cell `JobError`가 아니라 기존 `SearchJob.failureReason`의 `"interrupted"`와 `"store_error"`를 사용한다.
- 같은 orchestrator의 모든 job은 source scheduler 하나씩을 공유한다. Production server는 scheduler pair 하나를 주입하므로 process 전체 합산 in-flight concurrency는 source별 `2`이며 job 수에 따라 증가하지 않는다.
- 한 job의 429는 같은 source scheduler를 사용하는 다른 job도 pause하지만 반대 source scheduler는 계속 진행한다.
- transient 오류는 최초 호출 이후 최대 3회 재시도한다. 따라서 한 cell/source의 최대 총 시도 횟수는 4회다.
- 영구 오류는 최초 1회만 시도한다.
- retry 지연은 `baseDelayMs * 2 ** (retryNumber - 1) * (0.5 + random())`이다. 기본 `baseDelayMs=1000`, injected `random()=0.5`인 결정적 테스트의 지연은 `1000, 2000, 4000ms`다.
- HTTP 429의 `Retry-After`는 초 정수 또는 HTTP-date를 해석한다. 해당 source의 pause-until은 `max(now + exponentialDelay, parsed Retry-After)`이며 다른 source pause 상태와 공유하지 않는다.

### Phase 1 global scheduler compatibility

Phase 1 계약은 orchestrator factory마다 source scheduler pair 하나를 만들고 그 orchestrator의 모든 job이 공유한다. Phase 4 production composition은 process server가 pair 하나를 만들고 optional dependency로 주입해 동일한 lifetime을 명시한다. 기존 Phase 3/integration caller는 `schedulers`를 생략할 수 있고 factory fallback을 사용하므로 compile과 동작이 유지된다.

`maxAttempts`는 최초 호출을 포함하므로 Phase 4 기본값은 `4`이고, `shouldRetry(error, attempt)`는 `attempt < maxAttempts`인 transient 오류에만 `true`다.

```ts
// src/orchestrator/queue.ts — Phase 1 compatible contract
export interface ExecutionToken {
  shouldStop(): boolean;
}

export interface SourceSchedulerOptions {
  source: ProviderId;
  concurrency: number;
  minDelayMs: number;
  maxDelayMs: number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => string;
  retryBaseDelayMs: number;
  retryPolicy: RetryPolicy;
  limiterHooks: SourceLimiterHooks;
}

export class SourceScheduler {
  constructor(options: SourceSchedulerOptions);
  add(
    task: () => Promise<Quote>,
    token: ExecutionToken,
  ): Promise<QueueOutcome>;
  onIdle(): Promise<void>;
}

// src/orchestrator/index.ts
export interface SourceSchedulers {
  google: SourceScheduler;
  naver: SourceScheduler;
}

export interface OrchestratorDependencies {
  google: FlightProvider;
  naver: FlightProvider;
  store: JsonJobStore;
  generateDatePairs: (request: FlexibleSearchRequest) => DatePair[];
  createJobId: () => string;
  config?: OrchestratorConfigOverrides;
  schedulers?: SourceSchedulers;
}
```

`createSearchOrchestrator`는 Task 3의 inline `dependencies.schedulers ?? { google: makeScheduler(...), naver: makeScheduler(...) }`를 factory 본문에서 한 번 평가하고 `start()` 안에서는 생성하지 않는다. Production `server.ts`는 runtime config를 읽은 뒤 Google/Naver scheduler를 각각 한 번 생성해 주입한다.

```ts
// src/orchestrator/config.ts — existing API with additive retryBaseDelayMs
export interface RetryPolicy {
  maxAttempts: number;
  shouldRetry(error: unknown, attempt: number): boolean;
}

export interface SourceLimiterHooks {
  beforeAttempt(source: ProviderId): Promise<void>;
  afterFailure(source: ProviderId, error: unknown): Promise<void>;
}

export interface OrchestratorConfig {
  concurrencyPerSource: number;
  minDelayMs: number;
  maxDelayMs: number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => string;
  retryBaseDelayMs: number;
  retryPolicy: RetryPolicy;
  limiterHooks: SourceLimiterHooks;
  settledRuntimeLimit: number;
}
```

Global scheduler는 source별로 `active`, FIFO pending work, idle waiters, `pausedUntil`을 소유하고 기존 `limiterHooks.beforeAttempt/afterFailure`를 매 attempt 전후에 그대로 호출한다. 각 cell의 `ExecutionToken`은 job-local이며 scheduler는 Phase 1의 네 check point에서 `shouldStop()`을 호출한다. `now`와 `retryBaseDelayMs`는 `OrchestratorConfig`에서 두 `SourceSchedulerOptions`로 그대로 전달한다.

### Runtime configuration contract

```ts
// src/config/runtime.ts
export interface RuntimeConfig {
  dataDir: string;
  concurrencyPerSource: number;
  minDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  requestTimeoutMs: number;
}

export function loadRuntimeConfig(
  env?: NodeJS.ProcessEnv,
): RuntimeConfig;
```

환경값은 strict base-10 integer로 parse한다. 기본값은 concurrency `2`, delay `500..1500ms`, retries `3`, retry base `1000ms`, request timeout `30000ms`다. concurrency는 `1..4`, max retries는 `0..3` 범위 밖이면 clamp하고, delay/base/timeout의 음수·0 또는 `min > max`는 startup `RangeError`다. `maxRetries`는 기존 `RetryPolicy.maxAttempts = maxRetries + 1`로 wiring하며 shared type을 변경하지 않는다.

```ts
// src/orchestrator/error-taxonomy.ts
import type { JobErrorCode } from "../jobs/types.js";

export interface ClassifiedProviderError {
  code: JobErrorCode;
  message: string;
  transient: boolean;
  retryAfterMs?: number;
}

export function classifyProviderError(
  error: unknown,
  nowMs: number,
): ClassifiedProviderError;
```

오류 매핑은 source-local `ProviderFailure.code`를 가장 먼저 읽고, raw signal과 재귀적으로 보존된 `cause`는 transient 여부와 Retry-After만 보강한다.

| Raw signal | `JobErrorCode` | transient | Stable message |
|---|---|---:|---|
| `ProviderFailure.code === "provider_timeout"` | `provider_timeout` | yes | `Provider request timed out` |
| `ProviderFailure.code === "provider_blocked"` + status 429 | `provider_blocked` | yes | `Provider rate limit reached` |
| `ProviderFailure.code === "provider_blocked"` without 429, including 403 or DOM CAPTCHA/interstitial | `provider_blocked` | no | `Provider blocked the request` |
| `ProviderFailure.code === "no_direct_flight"` | `no_direct_flight` | no | `No direct round-trip flight found` |
| `ProviderFailure.code === "provider_error"` + status 500/502/503/504 or network cause | `provider_error` | yes | status면 `Provider service temporarily unavailable`, network면 `Provider network request failed` |
| `ProviderFailure.code === "provider_error"` without transient cause | `provider_error` | no | `Provider response could not be processed` |
| source-local code가 없는 `AbortError`/`TimeoutError`/`ETIMEDOUT` | `provider_timeout` | yes | `Provider request timed out` |
| source-local code가 없는 HTTP 429/403, 5xx, network error | 위와 동일한 기존 `JobErrorCode` | signal별 | 위와 동일 |

`JobErrorCode`에 `interrupted`, `store_error`, `rate_limited` 등을 추가하지 않는다. 공개 오류 코드 확장이 운영상 필요하다고 판단되면 구현 대신 `INTEGRATION CONTRACT CHANGE` 제목 아래에 충돌한 파일과 타입 이름, 재현한 입력과 실제 결과, 필요한 완전한 TypeScript 타입 정의를 순서대로 보고한다. 예를 들어 store 장애를 cell 오류로 노출해야 한다는 새 요구가 발견되면 `src/jobs/types.ts`의 현재 `JobErrorCode`로 표현할 수 없음을 적고, 통합 담당자가 검토할 완전한 union 정의를 제시한 뒤 Phase 4 구현을 중단한다.

## Task 1: Normalize provider errors into the existing taxonomy

**Files:**
- Create: `tests/orchestrator/error-taxonomy.test.ts`
- Create: `src/orchestrator/error-taxonomy.ts`
- Create: `tests/providers/google/error-metadata.test.ts`
- Create: `tests/providers/naver/error-metadata.test.ts`
- Modify: `src/providers/google/client.ts`
- Modify: `src/providers/google/provider.ts`
- Modify: `src/providers/naver/client.ts`
- Modify: `src/providers/naver/provider.ts`

- [ ] **Step 1: Write the failing table-driven taxonomy test**

Create `tests/orchestrator/error-taxonomy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../../src/orchestrator/error-taxonomy.js";

const NOW = Date.parse("2026-07-14T00:00:00.000Z");

describe("classifyProviderError", () => {
  it.each([
    [{ code: "provider_timeout" }, "provider_timeout", true, "Provider request timed out"],
    [{ code: "provider_blocked", status: 429, retryAfter: "7" }, "provider_blocked", true, "Provider rate limit reached"],
    [{ code: "provider_blocked", status: 403 }, "provider_blocked", false, "Provider blocked the request"],
    [{ code: "provider_blocked" }, "provider_blocked", false, "Provider blocked the request"],
    [{ code: "no_direct_flight" }, "no_direct_flight", false, "No direct round-trip flight found"],
    [{ code: "no_direct_flight", name: "TimeoutError" }, "no_direct_flight", false, "No direct round-trip flight found"],
    [{ code: "provider_error", cause: { status: 503 } }, "provider_error", true, "Provider service temporarily unavailable"],
    [{ code: "provider_error", cause: { code: "ECONNRESET" } }, "provider_error", true, "Provider network request failed"],
    [{ code: "provider_error" }, "provider_error", false, "Provider response could not be processed"],
    [{ name: "TimeoutError" }, "provider_timeout", true, "Provider request timed out"],
  ] as const)("maps %# without extending JobErrorCode", (raw, code, transient, message) => {
    expect(classifyProviderError(raw, NOW)).toMatchObject({ code, transient, message });
  });

  it("parses Retry-After seconds", () => {
    expect(
      classifyProviderError(
        { code: "provider_blocked", status: 429, retryAfter: "7" },
        NOW,
      ).retryAfterMs,
    ).toBe(7_000);
  });

  it("parses Retry-After HTTP-date relative to injected now", () => {
    expect(
      classifyProviderError(
        {
          code: "provider_blocked",
          status: 429,
          retryAfter: "Tue, 14 Jul 2026 00:00:09 GMT",
        },
        NOW,
      ).retryAfterMs,
    ).toBe(9_000);
  });

  it("clamps an expired or invalid Retry-After to undefined", () => {
    expect(
      classifyProviderError(
        { code: "provider_blocked", status: 429, retryAfter: "invalid" },
        NOW,
      ).retryAfterMs,
    ).toBeUndefined();
    expect(
      classifyProviderError(
        {
          code: "provider_blocked",
          status: 429,
          retryAfter: "Mon, 13 Jul 2026 23:59:59 GMT",
        },
        NOW,
      ).retryAfterMs,
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- tests/orchestrator/error-taxonomy.test.ts`

Expected: FAIL because `src/orchestrator/error-taxonomy.ts` does not exist.

- [ ] **Step 3: Implement structural error inspection and stable messages**

Create `src/orchestrator/error-taxonomy.ts` with:

```ts
import type { JobErrorCode } from "../jobs/types.js";

export interface ClassifiedProviderError {
  code: JobErrorCode;
  message: string;
  transient: boolean;
  retryAfterMs?: number;
}

type RawError = {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  retryAfter?: unknown;
  retryAfterMs?: unknown;
  cause?: unknown;
};

function asRaw(error: unknown): RawError {
  return typeof error === "object" && error !== null ? error : {};
}

function parseRetryAfter(raw: RawError, nowMs: number): number | undefined {
  if (typeof raw.retryAfterMs === "number" && raw.retryAfterMs > 0) return raw.retryAfterMs;
  if (typeof raw.retryAfter !== "string") return undefined;
  if (/^\d+$/.test(raw.retryAfter)) return Number(raw.retryAfter) * 1_000;
  const dateMs = Date.parse(raw.retryAfter);
  const delayMs = dateMs - nowMs;
  return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined;
}

const providerCodes = new Set([
  "provider_timeout",
  "provider_blocked",
  "no_direct_flight",
  "provider_error",
]);

export function classifyProviderError(
  error: unknown,
  nowMs: number,
): ClassifiedProviderError {
  const raw = asRaw(error);
  const cause = asRaw(raw.cause);
  const sourceCode = providerCodes.has(String(raw.code)) ? String(raw.code) : undefined;
  const status =
    typeof raw.status === "number"
      ? raw.status
      : typeof raw.statusCode === "number"
        ? raw.statusCode
        : typeof cause.status === "number"
          ? cause.status
          : cause.statusCode;
  const signalCode = sourceCode === undefined ? raw.code : cause.code;
  const retryAfterMs = parseRetryAfter(raw, nowMs) ?? parseRetryAfter(cause, nowMs);

  if (sourceCode === "provider_timeout") {
    return { code: "provider_timeout", transient: true, message: "Provider request timed out" };
  }
  if (sourceCode === "provider_blocked" && status === 429) {
    return {
      code: "provider_blocked",
      transient: true,
      message: "Provider rate limit reached",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (sourceCode === "provider_blocked") {
    return { code: "provider_blocked", transient: false, message: "Provider blocked the request" };
  }
  if (sourceCode === "no_direct_flight") {
    return {
      code: "no_direct_flight",
      transient: false,
      message: "No direct round-trip flight found",
    };
  }
  if (sourceCode === "provider_error" && [500, 502, 503, 504].includes(Number(status))) {
    return {
      code: "provider_error",
      transient: true,
      message: "Provider service temporarily unavailable",
    };
  }
  if (
    sourceCode === "provider_error" &&
    ["ECONNRESET", "EAI_AGAIN", "ENETUNREACH"].includes(String(signalCode))
  ) {
    return { code: "provider_error", transient: true, message: "Provider network request failed" };
  }
  if (sourceCode === "provider_error") {
    return {
      code: "provider_error",
      transient: false,
      message: "Provider response could not be processed",
    };
  }
  if (
    raw.name === "AbortError" ||
    raw.name === "TimeoutError" ||
    signalCode === "ETIMEDOUT"
  ) {
    return {
      code: "provider_timeout",
      transient: true,
      message: "Provider request timed out",
    };
  }
  if (status === 429) {
    return {
      code: "provider_blocked",
      transient: true,
      message: "Provider rate limit reached",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (status === 403) {
    return { code: "provider_blocked", transient: false, message: "Provider blocked the request" };
  }
  if ([500, 502, 503, 504].includes(Number(status))) {
    return {
      code: "provider_error",
      transient: true,
      message: "Provider service temporarily unavailable",
    };
  }
  if (["ECONNRESET", "EAI_AGAIN", "ENETUNREACH"].includes(String(signalCode))) {
    return { code: "provider_error", transient: true, message: "Provider network request failed" };
  }
  return {
    code: "provider_error",
    transient: false,
    message: "Provider response could not be processed",
  };
}
```

- [ ] **Step 4: Run taxonomy tests and confirm GREEN**

Run: `npm test -- tests/orchestrator/error-taxonomy.test.ts`

Expected: 1 test file passes, 13 test cases pass, and no network request occurs.

- [ ] **Step 5: Gate each source by its selected acquisition mode**

Read each source findings and approved Phase 2 addendum, then record exactly one branch in that source's `error-metadata.test.ts`:

```text
HTTP_RESPONSE_API
PLAYWRIGHT_CAPTURED_RESPONSE_API
PLAYWRIGHT_DOM_ONLY
BLOCKED_SELECTED_MODE_OR_RESPONSE_API_AMBIGUOUS
```

- `HTTP_RESPONSE_API`: native response exposes status and headers; run the 429 metadata branch.
- `PLAYWRIGHT_CAPTURED_RESPONSE_API`: findings/addendum explicitly name the captured response object and its status/header accessors; run the metadata branch using that injected fake API.
- `PLAYWRIGHT_DOM_ONLY`: extraction is stabilized DOM and blocking is detected by CAPTCHA/interstitial selector; run the metadata-absence/permanent-block branch.
- Ambiguous selected mode, extraction kind, or Playwright response API: do not add guessed accessors or status; mark only that source metadata enhancement `BLOCKED_SELECTED_MODE_OR_RESPONSE_API_AMBIGUOUS`.

The two sources may select different branches.

- [ ] **Step 6A: Write metadata tests only for a response-API branch**

For `HTTP_RESPONSE_API`, stub `fetch` with status `429` and header `Retry-After: 7`. For `PLAYWRIGHT_CAPTURED_RESPONSE_API`, use the exact injected fake response shape and accessor names copied from the approved source addendum. In either branch assert the client rejects with:

```ts
expect(client.search(input)).rejects.toMatchObject({
  name: "SourceClientHttpError",
  status: 429,
  retryAfter: "7",
});
```

Pass that client to the source provider and assert:

```ts
await expect(provider.findDirectRoundTrip(input)).rejects.toMatchObject({
  name: "ProviderFailure",
  code: "provider_blocked",
  status: 429,
  retryAfter: "7",
  cause: expect.objectContaining({
    name: "SourceClientHttpError",
    status: 429,
  }),
});
```

- [ ] **Step 6B: Write DOM-only permanent-block tests**

For `PLAYWRIGHT_DOM_ONLY`, use the Phase 2 injected fake page and exact findings selector to reproduce CAPTCHA and interstitial independently. Assert:

```ts
const clientError = await client.search(input).then(
  () => {
    throw new Error("expected DOM blocking");
  },
  (error: unknown) => error,
);
expect(clientError).toMatchObject({ code: "provider_blocked" });
expect(clientError).not.toHaveProperty("status");
expect(clientError).not.toHaveProperty("retryAfter");

const providerError = await provider.findDirectRoundTrip(input).then(
  () => {
    throw new Error("expected provider blocking");
  },
  (error: unknown) => error,
);
expect(providerError).toMatchObject({ code: "provider_blocked" });
expect(providerError).not.toHaveProperty("status");
expect(providerError).not.toHaveProperty("retryAfter");

expect(
  classifyProviderError(
    { code: "provider_blocked" },
    Date.parse("2026-07-14T00:00:00.000Z"),
  ),
).toMatchObject({
  code: "provider_blocked",
  transient: false,
});
```

Also submit this failure to `SourceScheduler.add(task, { shouldStop: () => false })` and assert one provider attempt, zero retry sleeps, and no source pause. Do not synthesize `429`, a status field, or `Retry-After`.

- [ ] **Step 7A: Capture metadata only at an evidenced response boundary**

Only for `HTTP_RESPONSE_API` or `PLAYWRIGHT_CAPTURED_RESPONSE_API`, define a source-local `SourceClientHttpError` and construct it where the selected implementation actually observes status/headers:

```ts
export class SourceClientHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | undefined,
    options?: ErrorOptions,
  ) {
    super(`Provider HTTP ${status}`, options);
    this.name = "SourceClientHttpError";
  }
}

const retryAfter = response.headers.get("retry-after") ?? undefined;
throw new SourceClientHttpError(response.status, retryAfter);
```

The final two lines are exact only for the HTTP `Response` branch. For a Playwright captured-response branch, copy the approved addendum's actual status/header accessor code verbatim; if it is absent, this step is blocked for that source. Preserve caller `AbortSignal`.

- [ ] **Step 7B: Preserve provider metadata conditionally**

For a response-API branch, preserve the existing four-value `ProviderFailureCode` union and extend only source-local `ProviderFailure` options/readonly fields:

```ts
type ProviderFailureOptions = ErrorOptions & {
  status?: number;
  retryAfter?: string;
};

export class ProviderFailure extends Error {
  readonly status?: number;
  readonly retryAfter?: string;

  constructor(
    readonly code: ProviderFailureCode,
    message: string,
    options: ProviderFailureOptions = {},
  ) {
    super(message, options);
    this.name = "ProviderFailure";
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}
```

Catch `SourceClientHttpError` before the generic branch:

```ts
if (error instanceof SourceClientHttpError) {
  const code =
    error.status === 403 || error.status === 429
      ? "provider_blocked"
      : "provider_error";
  throw new ProviderFailure(code, `${providerName} request failed`, {
    cause: error,
    status: error.status,
    ...(error.retryAfter === undefined
      ? {}
      : { retryAfter: error.retryAfter }),
  });
}
```

Do not add these fields to `src/providers/types.ts`, `JobError`, or MCP responses.

For `PLAYWRIGHT_DOM_ONLY`, do not add `SourceClientHttpError` and do not populate these fields. Preserve the existing source-local blocked failure path from the approved Phase 2 addendum; the provider may define optional fields for shape consistency, but they must remain absent.

- [ ] **Step 8: Run both source-gated error tests**

Run:

```bash
npm test -- tests/providers/google/error-metadata.test.ts
npm test -- tests/providers/naver/error-metadata.test.ts
```

Expected per source: response-API branch captures real status/Retry-After and classifies 429 transient; DOM-only branch proves CAPTCHA/interstitial has no metadata, is permanent, and is attempted once; ambiguous branch reports its exact blocked status without guessed code. Lowercase `no_direct_flight` remains permanent and no live network/browser runs.

- [ ] **Step 9: Commit**

```bash
git add src/orchestrator/error-taxonomy.ts src/providers/google/client.ts src/providers/google/provider.ts src/providers/naver/client.ts src/providers/naver/provider.ts tests/orchestrator/error-taxonomy.test.ts tests/providers/google/error-metadata.test.ts tests/providers/naver/error-metadata.test.ts
git commit -m "feat: normalize provider failures for retry decisions"
```

## Task 2: Add deterministic backoff to the global source scheduler

**Files:**
- Create: `tests/orchestrator/retry-policy.test.ts`
- Modify: `src/orchestrator/config.ts`
- Modify: `src/orchestrator/queue.ts`

- [ ] **Step 0: Verify the Phase 1 scheduler starting seam**

Run:

```bash
rg -n "interface ExecutionToken|interface SourceLimiterHooks|class SourceScheduler|add\\(task: \\(\\) => Promise<Quote>, token: ExecutionToken\\)|new SourceScheduler" src/orchestrator/config.ts src/orchestrator/queue.ts src/orchestrator/index.ts
```

Expected: Phase 1 exports `ExecutionToken { shouldStop() }`, `SourceLimiterHooks`, and `SourceScheduler.add(task, token)`; `index.ts` creates one pair in factory scope and none in `start()`. Task 3 adds only optional injected schedulers.

- [ ] **Step 1: Write tests against the global scheduler seam**

Create `tests/orchestrator/retry-policy.test.ts`. Construct one `SourceScheduler` for Google; inject `random: () => 0.5`, a `sleep` spy, `now: () => "2026-07-14T00:00:00.000Z"`, and `createOrchestratorConfig({ minDelayMs: 0, maxDelayMs: 0 })`. Cover:

```ts
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorConfig } from "../../src/orchestrator/config.js";
import { SourceScheduler } from "../../src/orchestrator/queue.js";

describe("Phase 4 retry through global SourceScheduler", () => {
  it("uses deterministic 1s, 2s, 4s delays and four total attempts", async () => {
    const sleep = vi.fn(async () => undefined);
    const config = createOrchestratorConfig({
      minDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0.5,
      sleep,
      now: () => "2026-07-14T00:00:00.000Z",
    });
    expect(config.retryBaseDelayMs).toBe(1_000);
    const scheduler = new SourceScheduler({
      source: "google",
      concurrency: 1,
      minDelayMs: config.minDelayMs,
      maxDelayMs: config.maxDelayMs,
      random: config.random,
      sleep: config.sleep,
      now: config.now,
      retryBaseDelayMs: config.retryBaseDelayMs,
      retryPolicy: config.retryPolicy,
      limiterHooks: config.limiterHooks,
    });
    const provider = vi.fn().mockRejectedValue({ code: "provider_timeout" });

    await expect(scheduler.add(
      provider,
      { shouldStop: () => false },
    )).resolves.toMatchObject({
      kind: "failure",
      source: "google",
    });
    expect(provider).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_000,
      2_000,
      4_000,
    ]);
  });

  it("does not retry a lowercase source-local no_direct_flight code", async () => {
    const sleep = vi.fn(async () => undefined);
    const config = createOrchestratorConfig({ minDelayMs: 0, maxDelayMs: 0, sleep });
    const scheduler = new SourceScheduler({
      source: "naver",
      concurrency: 1,
      minDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0.5,
      sleep,
      now: config.now,
      retryBaseDelayMs: config.retryBaseDelayMs,
      retryPolicy: config.retryPolicy,
      limiterHooks: config.limiterHooks,
    });
    const provider = vi.fn().mockRejectedValue({ code: "no_direct_flight" });

    await scheduler.add(provider, { shouldStop: () => false });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- tests/orchestrator/retry-policy.test.ts`

Expected: FAIL because Phase 1 scheduler still has no exponential delay.

- [ ] **Step 3: Extend config additively and activate existing seams**

In `src/orchestrator/config.ts`, keep every existing field/signature including `SourceLimiterHooks` and `settledRuntimeLimit`; add `retryBaseDelayMs: number` to `OrchestratorConfig` with default `1000` and positive-number validation. Change the default retry policy:

```ts
retryPolicy: {
  maxAttempts: 4,
  shouldRetry: (error, attempt) =>
    attempt < 4 &&
    classifyProviderError(error, 0).transient,
},
```

`shouldRetry`는 transient 여부만 소비한다. `OrchestratorConfigOverrides`의 existing partial `retryPolicy`/`limiterHooks` merge를 유지한다. 새 clock/random/hook interface를 만들지 않는다.

- [ ] **Step 4: Implement backoff and pause inside each global scheduler**

In `src/orchestrator/queue.ts`, add only `now` and `retryBaseDelayMs` to existing `SourceSchedulerOptions`; keep `ExecutionToken`, `add(task, token)`, `limiterHooks`, FIFO/concurrency, and the four `shouldStop()` check points. After each failure, preserve the Phase 1 order `await limiterHooks.afterFailure(source, error)` then `retryPolicy.shouldRetry(error, attempt)`. If retrying, calculate:

```ts
const retryNumber = attempt;
const exponentialMs =
  options.retryBaseDelayMs * 2 ** (retryNumber - 1);
const jitteredMs = Math.round(exponentialMs * (0.5 + options.random()));
const delayMs = Math.max(jitteredMs, classified.retryAfterMs ?? 0);
```

Keep one `pausedUntil` number inside each existing `SourceScheduler`; do not add another limiter class or change `SourceLimiterHooks`. For a transient 429, set:

```ts
const nowMs = Date.parse(options.now());
pausedUntil = Math.max(
  pausedUntil,
  nowMs + Math.max(jitteredMs, classified.retryAfterMs ?? 0),
);
```

Every attempt, including work from other jobs, waits `Math.max(0, pausedUntil - Date.parse(options.now()))` before invoking the existing `limiterHooks.beforeAttempt(source)`. Non-429 transient retries sleep only their calculated backoff. Invoke `afterFailure` exactly as Phase 1 requires, and recheck `token.shouldStop()` before/after every wait and after `beforeAttempt`.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run:

```bash
npm test -- tests/orchestrator/retry-policy.test.ts
npm test -- tests/orchestrator/config.test.ts tests/orchestrator/queue.test.ts
```

Expected: the new tests pass with 4 total attempts and `1000, 2000, 4000ms`; the corrected Phase 1 global scheduler/config tests remain green.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/config.ts src/orchestrator/queue.ts tests/orchestrator/retry-policy.test.ts
git commit -m "feat: add global source exponential backoff"
```

## Task 3: Prove cross-job global concurrency and pause

**Files:**
- Create: `tests/orchestrator/source-pause.test.ts`
- Modify: `src/orchestrator/config.ts`
- Modify: `src/orchestrator/queue.ts`
- Modify: `src/orchestrator/index.ts`

- [ ] **Step 1: Write orchestrator integration tests**

Create one Google `SourceScheduler` and one Naver `SourceScheduler`, inject both through optional `schedulers`, then start `job-a` and `job-b` before either completes. Test these exact regressions:

1. With two jobs queued concurrently, combined Google active calls never exceed `2`; combined Naver active calls never exceed `2`. This is process/source concurrency, not `2` per job.
2. `job-a` Google throws `{ code: "provider_blocked", status: 429, retryAfter: "9" }`; keep the shared Google pause unresolved and prove `job-b` starts no new Google attempt.
3. While Google is paused, both jobs' Naver work continues and reaches the pair barrier independently.
4. After releasing the Google pause, Google work from both jobs resumes under combined concurrency `2`.
5. Existing deterministic regressions remain: 503 succeeds on attempt 4 with `1000, 2000, 4000ms`, fourth transient failure is terminal, and lowercase `no_direct_flight` receives one attempt.
6. Construct another orchestrator with the pre-Phase-4 dependency object and no `schedulers`; it compiles, creates one fallback pair in factory scope, and two jobs still have aggregate source concurrency `2`.

Use a numeric fake clock initialized to `Date.parse("2026-07-14T00:00:00.000Z")`; expose `now: () => new Date(nowMs).toISOString()`. The Google sleep fake records milliseconds and returns a deferred Promise for the 9-second pause. Assert job-b has no new Google call while deferred, then advance `nowMs += 9_000` and resolve it. Naver sleep resolves immediately. Do not use fake wall-clock polling to prove pause duration.

The global limiter evidence must include:

```ts
expect(googlePeakActive).toBe(2);
expect(naverPeakActive).toBe(2);
expect(callsByJob.get("job-a")?.google).toBeGreaterThan(0);
expect(callsByJob.get("job-b")?.google).toBeGreaterThan(0);
expect(events).toContain("job-a:google:429");
expect(events.indexOf("job-b:naver:success"))
  .toBeLessThan(events.indexOf("google:pause:released"));
expect(events).not.toContain("job-b:google:during-pause");
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -- tests/orchestrator/source-pause.test.ts`

Expected: FAIL if scheduler state is job-local, aggregate concurrency reaches 4, or `job-b` Google bypasses `job-a`'s 429 pause.

- [ ] **Step 3: Add optional scheduler injection with factory fallback**

In `src/orchestrator/index.ts`, add only `schedulers?: SourceSchedulers` to `OrchestratorDependencies`. Resolve the pair once in `createSearchOrchestrator`:

```ts
const makeScheduler = (source: ProviderId) =>
  new SourceScheduler({
    source,
    concurrency: config.concurrencyPerSource,
    minDelayMs: config.minDelayMs,
    maxDelayMs: config.maxDelayMs,
    random: config.random,
    sleep: config.sleep,
    now: config.now,
    retryBaseDelayMs: config.retryBaseDelayMs,
    retryPolicy: config.retryPolicy,
    limiterHooks: config.limiterHooks,
  });

const schedulers = dependencies.schedulers ?? {
  google: makeScheduler("google"),
  naver: makeScheduler("naver"),
};
```

The nullish fallback is evaluated in factory scope, never inside `start()`/`execute()`. Submit each cell with the existing signature:

```ts
schedulers.google.add(
  () => dependencies.google.findDirectRoundTrip(input),
  { shouldStop: () =>
      runtime.cancellationRequested || runtime.fatal !== null },
);
```

Use the corresponding Naver scheduler/provider for Naver. Keep the existing callback-plus-token `add` form; do not introduce a task wrapper object or a second cancellation abstraction.

At the existing `QueueOutcome.failure` → `CellOutcome.failure` conversion, call:

```ts
const classified = classifyProviderError(
  outcome.cause,
  Date.parse(config.now()),
);
```

Build the `JobError` with pair dates, source, `classified.code`, `classified.message`, and `at: config.now()`. Do not change `mergePair`, pair barrier, or progress counters; retries remain invisible to pair-level progress.

- [ ] **Step 4: Run orchestrator regression suites**

Run:

```bash
npm test -- tests/orchestrator/source-pause.test.ts
npm test -- tests/orchestrator/queue.test.ts tests/orchestrator/orchestrator.test.ts
```

Expected: injected and omitted-scheduler cases both keep aggregate concurrency 2; same-source 429 pause crosses jobs; Naver continues; existing Phase 3/integration-shaped dependency objects compile unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/config.ts src/orchestrator/queue.ts src/orchestrator/index.ts tests/orchestrator/source-pause.test.ts
git commit -m "feat: share source backoff across jobs"
```

## Task 4: STOP and replan Google URL improvement

**Files:**
- Read: `docs/spikes/2026-07-14-google-findings.md`
- Conditional planning output only: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase4-google-url-addendum.md`
- Modify implementation: none

- [ ] **Step 1: Inspect findings for an exact URL recipe**

Require findings to identify the source-produced official URL field or a fully evidenced deterministic recipe, including every origin/path/encoding/parameter needed to reproduce origin, destination, departure date, return date, round trip, direct-only, adult 1, and economy. A valid recipe must be copied from captured evidence; browser observation, guessed query text, and known public URL conventions are insufficient.

- [ ] **Step 2: Preserve the existing official URL when recipe is unavailable**

Run: `npm test -- tests/providers/google`

Expected: Phase 2 parser/provider tests prove `Quote.url` is a valid official `http/https` URL from the recorded fixture. Keep that URL unchanged, mark Google URL improvement `BLOCKED_RECIPE_UNAVAILABLE`, and continue all non-URL hardening tasks.

- [ ] **Step 3: Create an addendum only when the exact recipe exists**

If and only if Step 1 succeeds, create the Google addendum with the writing-plans header, Ownership, Forbidden Writes, Dependencies, exact findings citations, copied recipe, fixture content, TDD commands, expected output, and commits. The addendum owns Google-only URL implementation/tests and must not modify shared contracts or Naver files.

- [ ] **Step 4: STOP for addendum review**

Do not implement URL code in this master hardening run. Return `REPLAN_REQUIRED_GOOGLE_URL` with the addendum path and stop this plan execution before the next task until integration review approves/dispatches the addendum and explicitly resumes non-URL hardening. Report Google URL exit as exactly one of:

```text
GOOGLE_URL=IMPROVED_BY_APPROVED_ADDENDUM
GOOGLE_URL=BLOCKED_RECIPE_UNAVAILABLE_EXISTING_OFFICIAL_URL_RETAINED
GOOGLE_URL=REPLAN_REQUIRED_ADDENDUM_PENDING
```

## Task 5: STOP and replan Naver URL improvement

**Files:**
- Read: `docs/spikes/2026-07-14-naver-findings.md`
- Conditional planning output only: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase4-naver-url-addendum.md`
- Modify implementation: none

- [ ] **Step 1: Inspect findings for an exact URL recipe**

Apply the same evidence bar as Task 4 to Naver-specific findings. The recipe must establish the complete official route/date/round-trip/direct/adult/economy encoding from captured evidence. Do not assume path segments or parameter names.

- [ ] **Step 2: Preserve the existing official URL when recipe is unavailable**

Run: `npm test -- tests/providers/naver`

Expected: Phase 2 parser/provider tests prove `Quote.url` is a valid official `http/https` URL from the recorded fixture. Keep that URL unchanged, mark Naver URL improvement `BLOCKED_RECIPE_UNAVAILABLE`, and continue all non-URL hardening.

- [ ] **Step 3: Create an addendum only when the exact recipe exists**

If and only if Step 1 succeeds, create `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase4-naver-url-addendum.md` with Naver-only ownership and the exact evidenced recipe/fixtures/tests. It must not copy Google assumptions or change shared contracts.

- [ ] **Step 4: STOP for addendum review**

Do not implement Naver URL code in this master hardening run. If an addendum was created, stop this plan execution before Task 6 until integration review explicitly resumes it. Return exactly one source status:

```text
NAVER_URL=IMPROVED_BY_APPROVED_ADDENDUM
NAVER_URL=BLOCKED_RECIPE_UNAVAILABLE_EXISTING_OFFICIAL_URL_RETAINED
NAVER_URL=REPLAN_REQUIRED_ADDENDUM_PENDING
```

## Task 6: Implement runtime config and request timeout wiring

**Files:**
- Create: `tests/config/runtime.test.ts`
- Create: `src/config/runtime.ts`
- Create: `tests/mcp/runtime-wiring.test.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/orchestrator/config.ts`
- Modify: `src/orchestrator/index.ts`
- Create: `tests/providers/google/timeout.test.ts`
- Create: `tests/providers/naver/timeout.test.ts`
- Modify: `src/providers/google/provider.ts`
- Modify: `src/providers/naver/provider.ts`

- [ ] **Step 1: Write runtime env parsing tests**

Create `tests/config/runtime.test.ts` with:

```ts
expect(loadRuntimeConfig({})).toEqual({
  dataDir: "./data/jobs",
  concurrencyPerSource: 2,
  minDelayMs: 500,
  maxDelayMs: 1500,
  maxRetries: 3,
  retryBaseDelayMs: 1000,
  requestTimeoutMs: 30000,
});

expect(loadRuntimeConfig({
  SEARCH_WAY_PROVIDER_CONCURRENCY: "99",
  SEARCH_WAY_MAX_RETRIES: "-1",
})).toMatchObject({
  concurrencyPerSource: 4,
  maxRetries: 0,
});

expect(() => loadRuntimeConfig({
  SEARCH_WAY_REQUEST_TIMEOUT_MS: "30s",
})).toThrow("SEARCH_WAY_REQUEST_TIMEOUT_MS");
expect(() => loadRuntimeConfig({
  SEARCH_WAY_MIN_DELAY_MS: "2000",
  SEARCH_WAY_MAX_DELAY_MS: "1000",
})).toThrow("SEARCH_WAY_MAX_DELAY_MS");
```

Also test concurrency `0 → 1`, retries `9 → 3`, custom data dir, zero/negative retry base or timeout rejection, and non-integer/empty strings.

- [ ] **Step 2: Run runtime config RED**

Run: `npm test -- tests/config/runtime.test.ts`

Expected: FAIL because `src/config/runtime.ts` does not exist.

- [ ] **Step 3: Implement strict parsing and clamping**

Implement `loadRuntimeConfig(env = process.env)` with the exact `RuntimeConfig` contract above. Use `/^-?\d+$/`, `Number`, and `Number.isSafeInteger`; do not use permissive `parseInt`. Clamp only concurrency and max retries. Reject invalid delay ordering and non-positive retry base/request timeout with a `RangeError` naming the environment variable.

- [ ] **Step 4: Write provider AbortSignal timeout tests**

In each source timeout test, inject a fake client whose `search(input, signal)` captures `signal` and rejects with `Object.assign(new Error("aborted"), { name: "AbortError" })` when the signal emits `abort`. Inject controllable timer functions into provider runtime options, fire the scheduled callback, and assert:

```ts
expect(capturedSignal).toBeInstanceOf(AbortSignal);
expect(capturedSignal!.aborted).toBe(false);
fireTimeout();
expect(capturedSignal!.aborted).toBe(true);
await expect(search).rejects.toMatchObject({
  code: "provider_timeout",
});
expect(clearTimeout).toHaveBeenCalledTimes(1);
```

Add a success case proving `clearTimeout` runs and no abort occurs. No real 30-second timer may remain active.

- [ ] **Step 5: Apply timeout at the provider→client call**

Keep `FlightProvider` unchanged. Add source-local constructor options:

```ts
interface ProviderRuntimeOptions {
  requestTimeoutMs: number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}
```

Default timer functions to the Node globals. Around the existing client call:

```ts
const controller = new AbortController();
const timeout = options.setTimeout(
  () => controller.abort(),
  options.requestTimeoutMs,
);
try {
  const captured = await this.client.search(input, controller.signal);
  return parseGoogleDirectRoundTrip(captured.body, captured.scrapedAt);
} finally {
  options.clearTimeout(timeout);
}
```

The Naver file uses its existing `parseNaverDirectRoundTrip` call in the same position. The existing AbortError mapping must produce source-local `ProviderFailure("provider_timeout", ...)`. This is the only request-timeout layer; scheduler backoff must not create another AbortController.

- [ ] **Step 6: Write production wiring tests**

Create `tests/mcp/runtime-wiring.test.ts` against an exported side-effect-free production composition factory from `server.ts`. Inject fake provider clients, store, ID factory, timer functions, and scheduler factory. Assert:

```ts
expect(createScheduler).toHaveBeenCalledTimes(2);
expect(createScheduler).toHaveBeenNthCalledWith(
  1,
  expect.objectContaining({
    source: "google",
    concurrency: 2,
    retryBaseDelayMs: 1000,
    now: expect.any(Function),
    limiterHooks: expect.any(Object),
  }),
);
expect(createScheduler).toHaveBeenNthCalledWith(
  2,
  expect.objectContaining({ source: "naver", concurrency: 2, retryBaseDelayMs: 1000 }),
);
expect(googleProviderOptions.requestTimeoutMs).toBe(30000);
expect(naverProviderOptions.requestTimeoutMs).toBe(30000);
expect(orchestratorConfig.retryPolicy.maxAttempts).toBe(4);
```

Start two jobs through the composed core and assert both use the same scheduler object identities. Also compile/run a legacy composition fixture that omits `schedulers` and assert the factory fallback still completes. The test imports `server.ts` without opening stdio or live clients.

- [ ] **Step 7: Wire runtime config without duplicating schedulers**

In `src/mcp/server.ts`, load config once, create `OrchestratorConfig` including `now`, `retryBaseDelayMs`, existing `limiterHooks`, and `maxRetries + 1`; construct one Google and one Naver scheduler from that same config; pass them through optional `schedulers` to `createSearchOrchestrator`. Construct providers with `requestTimeoutMs`. `index.ts` uses injected schedulers when present and factory-scope fallback otherwise; neither path allocates per-job schedulers.

- [ ] **Step 8: Verify runtime/timeout/wiring GREEN**

Run:

```bash
npm test -- tests/config/runtime.test.ts
npm test -- tests/providers/google/timeout.test.ts tests/providers/naver/timeout.test.ts
npm test -- tests/mcp/runtime-wiring.test.ts
npm run typecheck
```

Expected: env defaults/clamping/validation pass; both clients receive aborting signals; production creates exactly two schedulers; typecheck exits 0; no stdio, browser, or network opens.

- [ ] **Step 9: Commit**

```bash
git add src/config/runtime.ts src/mcp/server.ts src/orchestrator/config.ts src/orchestrator/index.ts src/providers/google/provider.ts src/providers/naver/provider.ts tests/config/runtime.test.ts tests/mcp/runtime-wiring.test.ts tests/providers/google/timeout.test.ts tests/providers/naver/timeout.test.ts
git commit -m "feat: wire validated runtime limits and timeouts"
```

## Task 7: Harden process restart and store failure behavior

**Files:**
- Create: `tests/jobs/recovery.test.ts`
- Create: `tests/jobs/store-errors.test.ts`
- Modify: `src/jobs/store.ts`
- Modify: `src/orchestrator/index.ts`

- [ ] **Step 1: Write restart recovery tests**

Use `fs.mkdtemp` under `os.tmpdir()` and real JSON files. Persist one `running`, one `queued`, and one `completed` job; construct a new store instance and call the existing `markInterrupted()`. Assert:

```ts
expect(await store.markInterrupted()).toBe(2);
expect((await store.get(runningId))).toMatchObject({
  status: "failed",
  failureReason: "interrupted",
});
expect((await store.get(queuedId))).toMatchObject({
  status: "failed",
  failureReason: "interrupted",
});
expect((await store.get(completedId))).toMatchObject({
  status: "completed",
  failureReason: undefined,
});
```

Assert recovered `updatedAt` equals the injected `now(): string`, existing results/errors/progress remain byte-for-byte equivalent, and a second `markInterrupted()` returns `0`.

- [ ] **Step 2: Run recovery test and confirm RED**

Run: `npm test -- tests/jobs/recovery.test.ts`

Expected: FAIL if queued/running jobs are not both persisted as failed/interrupted or recovery uses wall-clock time.

- [ ] **Step 3: Write disk/store failure tests**

Add an optional third constructor dependency to `JsonJobStore` for a source-local filesystem adapter while preserving `constructor(directory: string, now?: () => string)` callers. Cover:

1. temp write rejects with `ENOSPC`;
2. rename rejects with `EACCES`;
3. startup read encounters malformed JSON.

The store has no authoritative in-memory `SearchJob`. Therefore store-level assertions are only:

```ts
await expect(store.update(jobId, mutate)).rejects.toMatchObject({
  name: "JobStoreError",
  cause: expect.objectContaining({ code: "ENOSPC" }),
});
expect(await readableStore.get(jobId)).toEqual(lastDurableSnapshot);
```

For malformed JSON, `markInterrupted()` rejects a named `JobStoreError` with the `SyntaxError` as `cause`, and the corrupted file remains unchanged.

Add two orchestrator boundary cases:

1. A progress write fails once, then the top-level catch's best-effort `store.update` succeeds. `waitForIdle(jobId)` rejects the original `JobStoreError`, while `getStatus(jobId)` durably returns `status: "failed"` and `failureReason: "store_error"`.
2. The progress write and best-effort failure write both fail. `waitForIdle(jobId)` rejects an `AggregateError` containing both failures; `getStatus(jobId)` returns the last durable snapshot or rejects its own read error. It must not claim a durable failed/store_error snapshot.

Use the corrected Phase 1 runtime token contract: on the first fatal store error, synchronously mark only that job's runtime token terminal before best-effort persistence. Its queued global-scheduler tasks observe that token and do not call providers; another job sharing the same schedulers continues. Assert no cell-level `JobError` is fabricated, failed-job capacity is released, and `waitForIdle(failedJobId)` observes the stored rejection.

- [ ] **Step 4: Run store error test and confirm RED**

Run: `npm test -- tests/jobs/store-errors.test.ts`

Expected: FAIL because raw I/O errors are not wrapped and the orchestrator does not preserve both runtime failure and best-effort persistence outcomes.

- [ ] **Step 5: Add injected clock/filesystem and stable failure conversion**

Modify only the allowed `JsonJobStore` ranges. Keep the existing ISO-string clock contract and add an optional filesystem adapter defaulted to `node:fs/promises`. Recovery writes each queued/running job through the existing atomic path after setting:

```ts
job.status = "failed";
job.failureReason = "interrupted";
job.updatedAt = this.now();
```

Wrap read/parse/write/rename errors in `JobStoreError` with the original error as `cause`; do not cache or mutate an authoritative in-memory job.

In the existing `src/orchestrator/index.ts` background run top-level catch, stop scheduling work and attempt exactly one best-effort persistence:

```ts
try {
  await store.update(jobId, (current) => ({
    ...current,
    status: "failed",
    failureReason: "store_error",
    updatedAt: config.now(),
  }));
} catch (persistenceError) {
  throw new AggregateError(
    [runtimeError, persistenceError],
    "Search job failed and failure status could not be persisted",
  );
}
throw runtimeError;
```

Keep the rejected run Promise observable through `waitForIdle(jobId)` until the caller has awaited it. A successful best-effort write makes failed/store_error observable through `getStatus`; a failed best-effort write provides only runtime rejection plus the last readable durable snapshot. No shared `SearchJob` or `SearchOrchestrator` field is added.

- [ ] **Step 6: Verify all job and orchestrator tests**

Run:

```bash
npm test -- tests/jobs/recovery.test.ts tests/jobs/store-errors.test.ts
npm test -- tests/jobs tests/orchestrator
```

Expected: all tests pass; restart preserves partial data while marking unfinished jobs interrupted; one-shot failure persistence is durable when storage recovers; persistent disk failure is observable through `waitForIdle` without a false durable-status guarantee.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/store.ts src/orchestrator/index.ts tests/jobs/recovery.test.ts tests/jobs/store-errors.test.ts
git commit -m "fix: fail interrupted and unpersistable jobs safely"
```

## Task 8: Document polite production defaults and offline CI

**Files:**
- Modify: `.env.example`
- Create or Modify: `README.md`

- [ ] **Step 1: Update exact environment examples**

Set `.env.example` to include these non-secret defaults:

```dotenv
SEARCH_WAY_DATA_DIR=./data/jobs
SEARCH_WAY_PROVIDER_CONCURRENCY=2
SEARCH_WAY_MIN_DELAY_MS=500
SEARCH_WAY_MAX_DELAY_MS=1500
SEARCH_WAY_MAX_RETRIES=3
SEARCH_WAY_RETRY_BASE_DELAY_MS=1000
SEARCH_WAY_REQUEST_TIMEOUT_MS=30000
```

These values must match `src/config/runtime.ts`. `SEARCH_WAY_MAX_RETRIES=3` wires to four total attempts, and `SEARCH_WAY_REQUEST_TIMEOUT_MS=30000` controls the provider-created AbortSignal passed to each source client.

- [ ] **Step 2: Add the README operations guide**

Add sections with these exact operational facts:

- Node.js 20+ setup, `npm ci`, `.env.example` copy, `npm run build`, `npm run start:mcp`.
- Default source concurrency `2`; random polite delay `500–1500ms`; transient retry count `3`; exponential base `1000ms`; request timeout `30000ms`.
- Concurrency `2` is global per source across all jobs, not per job.
- Response API에서 관찰된 429는 affected source scheduler의 모든 job을 pause하고 `Retry-After`를 따른다; 다른 source는 계속한다. DOM-only CAPTCHA/interstitial, 403, no-direct-flight는 status를 합성하지 않는 영구 오류다.
- URL improvement is source-specific: without an exact Phase 0 recipe, retain the Phase 2 parser's validated official URL and report that source as `BLOCKED_RECIPE_UNAVAILABLE`; do not guess a URL.
- A process restart changes queued/running jobs to failed/interrupted and does not auto-resume.
- Disk/store failure triggers one best-effort failed/store_error persistence. If that write also fails, `waitForIdle` returns the runtime error and the last durable snapshot may still show its earlier status; free disk/repair permissions and start a new job.
- Partial successful results remain valid when individual cells fail; booking price and conditions must be rechecked at the returned URL.
- Personal-use, honest User-Agent, no credential sharing, no bulk/commercial scraping.
- CI commands are `npm run typecheck`, `npm test`, `npm run build`; none may make a live provider request.
- Live scraping is manual-only via `npm run spike:google` and `npm run spike:naver`, never a CI step and never part of default `npm test`.

- [ ] **Step 3: Verify documentation values against code**

Run:

```bash
rg "SEARCH_WAY_(PROVIDER_CONCURRENCY|MIN_DELAY_MS|MAX_DELAY_MS|MAX_RETRIES|RETRY_BASE_DELAY_MS|REQUEST_TIMEOUT_MS)" .env.example README.md src
rg "spike:(google|naver)" README.md package.json
npm test
```

Expected: every env key appears with the same numeric default in `.env.example`, README, and the existing config/retry code; spike commands appear only as manual operations; the complete test suite passes with no live network request.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: add safe flight search operations guide"
```

## Task 9: Run the Phase 4 offline gate

**Files:** No code changes expected.

- [ ] **Step 0: Resolve both URL evidence gates**

Record the exact Google and Naver URL status enum from Tasks 4/5. A blocked or pending URL addendum does not stop non-URL hardening and does not create a missing URL test path. Report `NON_URL_HARDENING=PASS|FAIL` separately from `GOOGLE_URL=...` and `NAVER_URL=...`; never collapse them into an unsupported all-or-nothing Phase 4 claim.

- [ ] **Step 1: Run focused hardening tests**

```bash
npm test -- tests/orchestrator/error-taxonomy.test.ts tests/orchestrator/retry-policy.test.ts tests/orchestrator/source-pause.test.ts
npm test -- tests/jobs/recovery.test.ts tests/jobs/store-errors.test.ts
npm test -- tests/providers/google/error-metadata.test.ts tests/providers/naver/error-metadata.test.ts
npm test -- tests/providers/google/timeout.test.ts tests/providers/naver/timeout.test.ts
npm test -- tests/config/runtime.test.ts tests/mcp/runtime-wiring.test.ts
```

Expected: all listed non-URL files pass; two concurrent jobs share source concurrency `2`; same-source 429 pause crosses job boundaries; other source proceeds; retry schedule is `1000, 2000, 4000ms`; timeout AbortSignals fire deterministically; env defaults/clamping pass.

- [ ] **Step 2: Run complete offline verification**

```bash
npm run typecheck
npm test
npm run build
```

Expected: all commands exit code 0; Vitest reports no failed/skipped hardening tests; no request reaches Google or Naver; build emits no TypeScript diagnostics.

- [ ] **Step 3: Inspect the final diff and ownership**

```bash
git status --short
git diff --check
git diff --name-only
```

Expected: `git diff --check` exits 0; every changed path is listed in Ownership; `src/jobs/types.ts` and `src/providers/types.ts` are absent.

- [ ] **Step 4: Commit any verification-only correction**

Only if a correction was required, stage the complete owned Phase 4 change set with this exact command:

```bash
git add .env.example README.md src/config/runtime.ts src/mcp/server.ts src/orchestrator/error-taxonomy.ts src/orchestrator/config.ts src/orchestrator/queue.ts src/orchestrator/index.ts src/jobs/store.ts src/providers/google/client.ts src/providers/google/provider.ts src/providers/naver/client.ts src/providers/naver/provider.ts tests/config/runtime.test.ts tests/mcp/runtime-wiring.test.ts tests/orchestrator/retry-policy.test.ts tests/orchestrator/error-taxonomy.test.ts tests/orchestrator/source-pause.test.ts tests/jobs/recovery.test.ts tests/jobs/store-errors.test.ts tests/providers/google/error-metadata.test.ts tests/providers/google/timeout.test.ts tests/providers/naver/error-metadata.test.ts tests/providers/naver/timeout.test.ts
git commit -m "test: close Phase 4 hardening regressions"
```

If no correction was required, do not create an empty commit.

## Verification

Run from repository root:

```bash
npm test -- tests/orchestrator/error-taxonomy.test.ts tests/orchestrator/retry-policy.test.ts tests/orchestrator/source-pause.test.ts
npm test -- tests/jobs/recovery.test.ts tests/jobs/store-errors.test.ts
npm test -- tests/providers/google/error-metadata.test.ts tests/providers/naver/error-metadata.test.ts
npm test -- tests/providers/google/timeout.test.ts tests/providers/naver/timeout.test.ts
npm test -- tests/config/runtime.test.ts tests/mcp/runtime-wiring.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

Expected:

- all commands exit code 0;
- transient failures receive at most 3 retries (4 total attempts);
- deterministic backoff is `1000, 2000, 4000ms`;
- two simultaneous jobs have aggregate concurrency `2` per source;
- 429 honors `Retry-After`, pauses all jobs on that source scheduler, and does not pause the other source;
- permanent failures are attempted once;
- raw provider failures map only to the existing `JobErrorCode` union;
- response-API clients capture observed 429 status/Retry-After; DOM-only clients keep CAPTCHA/interstitial status-less and permanent; all clients receive request-timeout AbortSignals;
- runtime env defaults, strict parsing, clamping, and production scheduler/provider wiring pass;
- URL status is reported per source; unavailable recipe retains Phase 2's validated official URL while non-URL hardening can pass;
- restart marks queued/running jobs `failed/interrupted` while preserving partial data;
- store errors reject `waitForIdle`; failed/store_error is durable only when the one-shot best-effort write succeeds, and no cell error is fabricated;
- the complete suite performs no live scraping.

## Output

The implementing agent must report:

- changed files, grouped as Phase 1 core, Phase 2 providers, new tests, and operations docs;
- focused and full verification commands with pass/fail and test counts;
- observed retry delays, maximum attempt count, and permanent-error attempt count;
- two-job aggregate peak concurrency and cross-job same-source pause/other-source progress evidence;
- per-source acquisition branch, observed metadata or DOM-only metadata absence, provider cause propagation, and timeout AbortSignal evidence;
- runtime config defaults/clamping and production global scheduler identity evidence;
- exact Google/Naver URL status enum, retained Phase 2 official URL evidence, and addendum path when replan is required;
- interrupted/store-error test evidence;
- any `INTEGRATION CONTRACT CHANGE` with exact requested type diff;
- `BLOCKED` instead of modifying a forbidden/shared-contract file.

## Self-Review Checklist

- [x] Every design §7 concurrency/retry/persistence requirement maps to Tasks 2, 3, or 7.
- [x] Every design §8 error case maps to the existing `JobErrorCode` or `failureReason`; no new public code is silently introduced.
- [x] Design §9/§10 offline CI, secrets, politeness, and personal-use rules appear in Task 8.
- [x] URL hardcoding is absent; exact findings recipe triggers a source-specific STOP/replan addendum, while unavailable recipe retains the Phase 2 official URL and does not block non-URL hardening.
- [x] Existing `config.now`, `random`, and `sleep` are injected; no test depends on wall-clock time, real timers, or probabilistic jitter.
- [x] Retry means 3 retries after the initial attempt, not 3 total attempts.
- [x] Two jobs share source concurrency `2`; same-source pause crosses jobs and cannot block the other source.
- [x] Each source follows its findings-selected mode: real response APIs propagate 429 metadata, while DOM-only CAPTCHA/interstitial stays status-less, permanent, and non-retried.
- [x] Runtime env loader, server wiring, and provider AbortSignal timeout have exact ownership and offline tests.
- [x] Store failure does not pretend an unsuccessful best-effort disk write was durable.
- [x] All file paths, commands, expected outputs, and commit messages are concrete.
- [x] No placeholder text or live scraping command appears in automated verification.
