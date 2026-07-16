# Flexible Flight Search Phase 1 Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 고정된 shared types와 Phase 0 날짜 조합기를 소비하여 결과 병합, 출처별 독립·전역 공유 scheduler, 원자적 JSON job store, 비동기 orchestrator 및 mock provider 50쌍 G4를 구현한다.

**Architecture:** `merge-results.ts`는 한 날짜쌍의 두 cell 결과를 순수하게 병합하고, `queue.ts`는 orchestrator 인스턴스 전체가 공유하는 Google/Naver source scheduler를 각각 하나씩 제공해 여러 job의 합산 concurrency와 향후 429 pause를 출처 단위로 제한한다. `index.ts`는 queued snapshot을 만든 뒤 provider enqueue 전에 running을 원자적으로 저장하고, 두 cell Promise를 pair barrier로 묶어 양쪽 종료 뒤에만 progress를 갱신하며, `store.ts`는 job별 Promise chain과 temp+rename으로 스냅샷을 직렬화·원자화한다.

**Tech Stack:** Node.js 20+, TypeScript NodeNext/ESM, Vitest, Node `fs/promises`, 고정 shared contracts (`src/domain/types.ts`, `src/providers/types.ts`, `src/jobs/types.ts`)

---

## Ownership

이 계획의 구현 agent만 다음 파일을 생성하거나 수정한다.

- `src/orchestrator/config.ts`
- `src/orchestrator/merge-results.ts`
- `src/orchestrator/queue.ts`
- `src/orchestrator/index.ts`
- `src/jobs/store.ts`
- `tests/orchestrator/config.test.ts`
- `tests/orchestrator/merge-results.test.ts`
- `tests/orchestrator/queue.test.ts`
- `tests/orchestrator/orchestrator.test.ts`
- `tests/jobs/store.test.ts`
- `tests/helpers/mock-provider.ts`
- `tests/helpers/eventually.ts`

## Forbidden Writes

- 공통 계약: `src/domain/types.ts`, `src/providers/types.ts`, `src/jobs/types.ts`
- Phase 0 소유: `src/domain/date-combinator.ts`, `tests/domain/date-combinator.test.ts`, `scripts/**`, `docs/spikes/**`
- 실제 provider: `src/providers/google/**`, `src/providers/naver/**`, `tests/providers/**`
- MCP 계층: `src/mcp/**`, `tests/mcp/**`
- 프로젝트 기반: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- 이 문서를 제외한 `docs/**`

공통 타입의 필드명·선택성·오류 코드가 아래 Contract와 다르면 우회 타입, type assertion, 중복 타입을 만들지 않는다. 변경이 필요한 이유와 정확한 차이를 보고하고 `BLOCKED`로 종료한다.

## Dependencies

- `docs/superpowers/plans/2026-07-14-flexible-flight-search-contracts.md`가 완료되어 shared types가 존재해야 한다.
- Phase 0 G1, G2, G3 gate가 통과해야 한다.
- `src/domain/date-combinator.ts`가 `generateDatePairs(request: FlexibleSearchRequest): DatePair[]`를 export해야 한다. export 이름 또는 signature가 다르면 실제 Phase 0 공개 API를 import하도록 이 계획의 호출부만 조정할 수 있지만 해당 파일은 수정하지 않는다.
- Node.js 20+와 npm dependencies가 contracts 계획대로 설치되어 있어야 한다.
- 모든 테스트는 mock provider와 임시 디렉터리만 사용하며 live Google/Naver 요청을 하지 않는다.

## Contract

### 소비하는 고정 계약

```ts
// src/domain/types.ts
export interface FlexibleSearchRequest {
  origin: string;
  destination: string;
  months: string[];
  minTripDays: number;
  maxTripDays: number;
  departureWeekdays: number[];
  returnWeekdays: number[];
}

export interface DatePair {
  departureDate: string;
  returnDate: string;
  tripDays: number;
}
```

```ts
// src/providers/types.ts
export type ProviderId = "google" | "naver";

export interface Quote {
  price: number;
  currency: string;
  url: string;
  airline?: string;
  scrapedAt: string;
}

export interface ProviderSearchInput extends DatePair {
  origin: string;
  destination: string;
}

export interface FlightProvider {
  readonly id: ProviderId;
  findDirectRoundTrip(input: ProviderSearchInput): Promise<Quote>;
}
```

```ts
// src/jobs/types.ts
export interface SearchJob {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  request: FlexibleSearchRequest;
  progress: {
    totalPairs: number;
    completedPairs: number;
    failedPairs: number;
    googleOk: number;
    naverOk: number;
  };
  results: SearchResultRow[];
  errors: JobError[];
  cancellationRequested: boolean;
  failureReason?: "interrupted" | "store_error" | "startup_error";
}
```

### Phase 1 공개 API

```ts
// src/orchestrator/config.ts
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
  retryPolicy: RetryPolicy;
  limiterHooks: SourceLimiterHooks;
  settledRuntimeLimit: number;
}

export type OrchestratorConfigOverrides = Partial<
  Omit<OrchestratorConfig, "retryPolicy" | "limiterHooks">
> & {
  retryPolicy?: Partial<RetryPolicy>;
  limiterHooks?: Partial<SourceLimiterHooks>;
};

export function createOrchestratorConfig(
  overrides?: OrchestratorConfigOverrides,
): OrchestratorConfig;
```

Phase 1 기본값은 출처별 **전체 job 합산** concurrency `2`, jitter `500..1500ms`, `maxAttempts: 1`, 종료 runtime 보존 상한 `100`이다. `SourceLimiterHooks`는 scheduler-level seam이다. Phase 1에서는 두 hook 모두 no-op이며, Phase 4는 `afterFailure`에서 source별 `blockedUntil`을 갱신하고 `beforeAttempt`에서 그 시각까지 기다리게 하여 같은 orchestrator의 모든 job에 429 pause를 공유한다. `RetryPolicy`는 Phase 4가 exponential backoff·오류 분류를 추가할 seam이며 Phase 1에서는 재시도하지 않는다.

```ts
// src/orchestrator/merge-results.ts
export type CellOutcome =
  | { kind: "success"; source: ProviderId; quote: Quote }
  | { kind: "failure"; source: ProviderId; error: JobError }
  | { kind: "cancelled"; source: ProviderId };

export interface PairMerge {
  row: SearchResultRow | null;
  errors: JobError[];
  failed: boolean;
  googleOk: number;
  naverOk: number;
}

export function mergePair(
  pair: DatePair,
  google: CellOutcome,
  naver: CellOutcome,
  now: () => string,
): PairMerge;

export function sortResults(rows: SearchResultRow[]): SearchResultRow[];
```

- 한쪽 성공이면 그 quote가 `best`이고 row를 만든다.
- 양쪽 성공·동일 통화면 더 싼 quote가 `best`, 가격 동점이면 Google이 `best`다.
- 양쪽 실패면 row 없이 `failed=true`다.
- 양쪽 성공·통화 불일치면 row 없이 source별 `currency_mismatch` 오류 2개와 `failed=true`다.
- `cancelled`가 하나라도 있으면 미완료 pair이므로 orchestrator는 `mergePair`를 호출하지 않는다.
- `results`는 `best.price`, `departureDate`, `returnDate` 순으로 안정적·결정적으로 정렬한다.

```ts
// src/orchestrator/queue.ts
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
  retryPolicy: RetryPolicy;
  limiterHooks: SourceLimiterHooks;
}

export type QueueOutcome =
  | { kind: "success"; source: ProviderId; quote: Quote }
  | { kind: "failure"; source: ProviderId; cause: unknown }
  | { kind: "cancelled"; source: ProviderId };

export class SourceScheduler {
  constructor(options: SourceSchedulerOptions);
  add(task: () => Promise<Quote>, token: ExecutionToken): Promise<QueueOutcome>;
  onIdle(): Promise<void>;
}
```

`createSearchOrchestrator` 호출 시 Google용 `SourceScheduler`와 Naver용 `SourceScheduler`를 각각 정확히 하나 만들고 모든 job이 이를 공유한다. scheduler는 task별 `ExecutionToken`을 시작 직전, jitter sleep 뒤, limiter hook 뒤, retry 시도 직전에 확인한다. token이 cancellation 또는 fatal이면 provider를 호출하지 않고 `cancelled` outcome을 반환한다. `beforeAttempt`/`afterFailure`도 scheduler instance에 귀속되므로 Phase 4의 source pause가 job 경계를 넘어 적용된다.

```ts
// src/jobs/store.ts
export class JobNotFoundError extends Error {}

export class JsonJobStore {
  constructor(directory: string, now?: () => string);
  create(job: SearchJob): Promise<void>;
  get(jobId: string): Promise<SearchJob>;
  update(jobId: string, mutate: (job: SearchJob) => SearchJob): Promise<SearchJob>;
  markInterrupted(): Promise<number>;
}
```

`create`와 `update`는 `{jobId}.{randomUUID}.tmp`에 완전한 JSON을 쓰고 같은 디렉터리의 `{jobId}.json`으로 rename한다. 동일 job의 작업은 instance 내 Promise chain으로 직렬화하고, 반환값은 `structuredClone`하여 caller mutation이 store 상태를 바꾸지 못하게 한다. 시작 시 `markInterrupted()`는 `queued` 또는 `running`을 `failed`, `failureReason="interrupted"`로 바꾸고 건수를 반환한다.

```ts
// src/orchestrator/index.ts
export interface StartSearchResult {
  jobId: string;
  totalPairs: number;
  status: "queued";
}

export interface SearchOrchestrator {
  recoverInterrupted(): Promise<number>;
  start(request: FlexibleSearchRequest): Promise<StartSearchResult>;
  getStatus(jobId: string): Promise<SearchJob>;
  cancel(jobId: string): Promise<SearchJob>;
  waitForIdle(jobId: string): Promise<void>;
  releaseRuntime(jobId: string): boolean;
}

export interface OrchestratorDependencies {
  google: FlightProvider;
  naver: FlightProvider;
  store: JsonJobStore;
  generateDatePairs: (request: FlexibleSearchRequest) => DatePair[];
  createJobId: () => string;
  config?: OrchestratorConfigOverrides;
}

export function createSearchOrchestrator(
  dependencies: OrchestratorDependencies,
): SearchOrchestrator;
```

- `start`는 pair를 생성하고 queued snapshot을 영속화한 뒤 실행을 microtask로 예약하여 즉시 queued 응답을 반환한다. 실행 microtask의 첫 작업은 `store.update`로 `status="running"`을 원자적으로 저장하는 것이며, 이 update가 성공하기 전에는 cell을 scheduler에 넣지 않는다.
- 두 source scheduler는 factory scope에 한 번만 생성되어 모든 job이 공유한다. 따라서 두 동시 job의 합산 provider별 peak concurrency도 2다.
- 각 pair의 Google/Naver cell을 모두 큐에 넣고 `Promise.all` barrier가 끝난 뒤에만 `completedPairs`를 1 증가시킨다.
- cancellation으로 시작되지 않은 cell이 있으면 그 pair는 completed/failed 집계에서 제외한다.
- provider failure는 cell error이고 job system failure가 아니다. 양쪽 cell 실패 또는 통화 불일치만 `failedPairs`를 증가시킨다.
- 실행 중 pair가 끝날 때마다 job별 직렬화 update에서 partial results를 merge·sort한다.
- runtime은 `{ cancellationRequested, fatal, run, settled, settledAt }`를 가진다. 모든 task token은 `cancellationRequested || fatal !== null`을 읽는다. 첫 store failure를 runtime fatal로 고정하면 global scheduler에 이미 등록됐지만 시작 전인 모든 cell이 provider 호출 없이 종료된다.
- `cancel`은 pending cell을 즉시 막기 위해 runtime의 `cancellationRequested`를 store await 전에 설정하고, `store.update` mutator 안에서 current status를 검사한다. `completed`, `failed`, `cancelled`이면 snapshot과 timestamp를 그대로 반환하며, non-terminal일 때만 persisted status를 `cancelled`로 바꾼다. 이미 terminal인 runtime token이 true가 되어도 provider 작업은 모두 종료됐으므로 외부 상태 변화는 없다.
- 시스템 시작/스토어 오류만 job `failed`다. pair/final store update 실패는 fatal token을 먼저 trip한 뒤 가능한 경우 `failed/store_error`를 저장하고 run Promise를 reject한다.
- `waitForIdle`은 runtime map에 보존된 원래 `run` Promise를 await하므로 settle 뒤 호출해도 성공/rejection을 동일하게 관찰한다. Phase 3 MCP 공개 도구에는 노출하지 않는 내부 lifecycle API다.
- 명시적 `releaseRuntime(jobId)`는 settled runtime만 삭제하고 실행 중이면 `false`다. 누락 방지를 위해 settle 순서 FIFO에서 `settledRuntimeLimit=100`을 초과한 가장 오래된 settled runtime을 자동 제거한다. 제거된 terminal job의 `waitForIdle`은 store snapshot이 terminal인지 확인해 resolve하지만 원래 rejection 재관찰은 보존 창 내 또는 명시적 release 전까지만 보장한다.

## File Responsibility Map

- `src/orchestrator/config.ts`: 기본 concurrency/jitter/retry, source-wide pause hook, runtime retention 설정과 범위 검증만 담당한다.
- `src/orchestrator/merge-results.ts`: pair 병합, best 선택, 통화 불일치, 결과 정렬만 담당한다.
- `src/orchestrator/queue.ts`: orchestrator-wide 단일 source scheduler의 합산 concurrency, jitter, task token, source-wide pause hook만 담당한다.
- `src/orchestrator/index.ts`: 두 전역 scheduler 소유, job lifecycle, running transition, fatal/cancel token, pair barrier, progress persistence, runtime retention만 담당한다.
- `src/jobs/store.ts`: JSON 파일 이름 검증, clone, job별 직렬화, temp+rename, restart recovery만 담당한다.
- `tests/helpers/mock-provider.ts`: 호출 기록과 수동 resolve/reject가 가능한 provider test double만 담당한다.
- `tests/helpers/eventually.ts`: fake timer 없이 persisted 상태를 제한 시간 polling하는 helper만 담당한다.

## Task 1: Lock configuration and Phase 4 retry seam

**Files:**
- Create: `src/orchestrator/config.ts`
- Create: `tests/orchestrator/config.test.ts`

- [ ] **Step 1: Write the failing configuration tests**

Create `tests/orchestrator/config.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorConfig } from "../../src/orchestrator/config.js";

describe("createOrchestratorConfig", () => {
  it("uses polite Phase 1 defaults and no retries", () => {
    const config = createOrchestratorConfig();

    expect(config.concurrencyPerSource).toBe(2);
    expect(config.minDelayMs).toBe(500);
    expect(config.maxDelayMs).toBe(1500);
    expect(config.retryPolicy.maxAttempts).toBe(1);
    expect(config.retryPolicy.shouldRetry(new Error("temporary"), 1)).toBe(false);
    expect(config.settledRuntimeLimit).toBe(100);
  });

  it("keeps clock, limiter hooks, random, sleep, and retry policy injectable", async () => {
    const sleep = vi.fn(async () => undefined);
    const beforeAttempt = vi.fn(async () => undefined);
    const afterFailure = vi.fn(async () => undefined);
    const now = () => "2026-07-14T00:00:00.000Z";
    const config = createOrchestratorConfig({
      minDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0.25,
      sleep,
      now,
      retryPolicy: { maxAttempts: 2, shouldRetry: () => true },
      limiterHooks: { beforeAttempt, afterFailure },
      settledRuntimeLimit: 7,
    });

    await config.sleep(7);
    await config.limiterHooks.beforeAttempt("google");
    await config.limiterHooks.afterFailure("google", new Error("429"));
    expect(sleep).toHaveBeenCalledWith(7);
    expect(beforeAttempt).toHaveBeenCalledWith("google");
    expect(afterFailure).toHaveBeenCalledOnce();
    expect(config.now()).toBe("2026-07-14T00:00:00.000Z");
    expect(config.retryPolicy.maxAttempts).toBe(2);
    expect(config.settledRuntimeLimit).toBe(7);
  });

  it.each([
    [{ concurrencyPerSource: 0 }, "concurrencyPerSource"],
    [{ minDelayMs: -1 }, "minDelayMs"],
    [{ minDelayMs: 10, maxDelayMs: 9 }, "maxDelayMs"],
    [{ retryPolicy: { maxAttempts: 0 } }, "maxAttempts"],
    [{ settledRuntimeLimit: 0 }, "settledRuntimeLimit"],
  ])("rejects invalid override %j", (override, field) => {
    expect(() => createOrchestratorConfig(override)).toThrow(field);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/orchestrator/config.test.ts`

Expected: FAIL with `Cannot find module '../../src/orchestrator/config.js'`.

- [ ] **Step 3: Implement the minimal validated configuration**

Create `src/orchestrator/config.ts`:

```ts
import type { ProviderId } from "../providers/types.js";

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
  retryPolicy: RetryPolicy;
  limiterHooks: SourceLimiterHooks;
  settledRuntimeLimit: number;
}

export type OrchestratorConfigOverrides = Partial<
  Omit<OrchestratorConfig, "retryPolicy" | "limiterHooks">
> & {
  retryPolicy?: Partial<RetryPolicy>;
  limiterHooks?: Partial<SourceLimiterHooks>;
};

const defaults: OrchestratorConfig = {
  concurrencyPerSource: 2,
  minDelayMs: 500,
  maxDelayMs: 1500,
  random: Math.random,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => new Date().toISOString(),
  retryPolicy: {
    maxAttempts: 1,
    shouldRetry: () => false,
  },
  limiterHooks: {
    beforeAttempt: async () => undefined,
    afterFailure: async () => undefined,
  },
  settledRuntimeLimit: 100,
};

export function createOrchestratorConfig(
  overrides: OrchestratorConfigOverrides = {},
): OrchestratorConfig {
  const config: OrchestratorConfig = {
    ...defaults,
    ...overrides,
    retryPolicy: { ...defaults.retryPolicy, ...overrides.retryPolicy },
    limiterHooks: { ...defaults.limiterHooks, ...overrides.limiterHooks },
  };

  if (!Number.isInteger(config.concurrencyPerSource) || config.concurrencyPerSource < 1) {
    throw new RangeError("concurrencyPerSource must be a positive integer");
  }
  if (!Number.isFinite(config.minDelayMs) || config.minDelayMs < 0) {
    throw new RangeError("minDelayMs must be non-negative");
  }
  if (!Number.isFinite(config.maxDelayMs) || config.maxDelayMs < config.minDelayMs) {
    throw new RangeError("maxDelayMs must be greater than or equal to minDelayMs");
  }
  if (!Number.isInteger(config.retryPolicy.maxAttempts) || config.retryPolicy.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  if (!Number.isInteger(config.settledRuntimeLimit) || config.settledRuntimeLimit < 1) {
    throw new RangeError("settledRuntimeLimit must be a positive integer");
  }
  return config;
}
```

- [ ] **Step 4: Verify GREEN and type safety**

Run: `npm test -- tests/orchestrator/config.test.ts && npm run typecheck`

Expected: 7 tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/config.ts tests/orchestrator/config.test.ts
git commit -m "feat: define orchestrator runtime configuration"
```

## Task 2: Merge pair outcomes deterministically

**Files:**
- Create: `src/orchestrator/merge-results.ts`
- Create: `tests/orchestrator/merge-results.test.ts`

- [ ] **Step 1: Write failing best, failure, currency, and sorting tests**

Create `tests/orchestrator/merge-results.test.ts` with fixtures for `pair`, Google KRW 100000, Naver KRW 100000, and failures, then assert:

```ts
import { describe, expect, it } from "vitest";
import type { DatePair } from "../../src/domain/types.js";
import type { JobError } from "../../src/jobs/types.js";
import type { ProviderId, Quote } from "../../src/providers/types.js";
import {
  mergePair,
  sortResults,
  type CellOutcome,
} from "../../src/orchestrator/merge-results.js";

const pair: DatePair = {
  departureDate: "2026-10-01",
  returnDate: "2026-10-05",
  tripDays: 5,
};
const quote = (price: number, currency = "KRW"): Quote => ({
  price,
  currency,
  url: `https://example.test/${price}`,
  scrapedAt: "2026-07-14T00:00:00.000Z",
});
const success = (source: ProviderId, value: Quote): CellOutcome => ({
  kind: "success",
  source,
  quote: value,
});
const failure = (source: ProviderId): CellOutcome => {
  const error: JobError = {
    departureDate: pair.departureDate,
    returnDate: pair.returnDate,
    source,
    code: "provider_error",
    message: `${source} failed`,
    at: "2026-07-14T00:00:00.000Z",
  };
  return { kind: "failure", source, error };
};
const now = () => "2026-07-14T00:00:01.000Z";

describe("mergePair", () => {
  it("uses Google for an equal-price tie", () => {
    const merged = mergePair(
      pair,
      success("google", quote(100_000)),
      success("naver", quote(100_000)),
      now,
    );
    expect(merged.row?.best.source).toBe("google");
    expect(merged.failed).toBe(false);
    expect([merged.googleOk, merged.naverOk]).toEqual([1, 1]);
  });

  it("keeps a row when only one source succeeds", () => {
    const merged = mergePair(
      pair,
      failure("google"),
      success("naver", quote(90_000)),
      now,
    );
    expect(merged.row?.google).toBeNull();
    expect(merged.row?.best.source).toBe("naver");
    expect(merged.errors).toHaveLength(1);
    expect(merged.failed).toBe(false);
  });

  it("counts both-source failure and omits the row", () => {
    const merged = mergePair(pair, failure("google"), failure("naver"), now);
    expect(merged.row).toBeNull();
    expect(merged.errors).toHaveLength(2);
    expect(merged.failed).toBe(true);
  });

  it("rejects incomparable currencies as a failed pair", () => {
    const merged = mergePair(
      pair,
      success("google", quote(100, "USD")),
      success("naver", quote(130_000, "KRW")),
      now,
    );
    expect(merged.row).toBeNull();
    expect(merged.failed).toBe(true);
    expect(merged.errors.map((error) => error.code)).toEqual([
      "currency_mismatch",
      "currency_mismatch",
    ]);
  });

  it("sorts partial rows by price then dates", () => {
    const a = mergePair(
      pair,
      success("google", quote(120_000)),
      failure("naver"),
      now,
    ).row!;
    const bPair = { ...pair, departureDate: "2026-09-30", returnDate: "2026-10-04" };
    const b = mergePair(
      bPair,
      success("google", quote(100_000)),
      failure("naver"),
      now,
    ).row!;
    expect(sortResults([a, b]).map((row) => row.departureDate)).toEqual([
      "2026-09-30",
      "2026-10-01",
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/orchestrator/merge-results.test.ts`

Expected: FAIL with missing `merge-results.js`.

- [ ] **Step 3: Implement `CellOutcome`, `mergePair`, and immutable sort**

Implement `src/orchestrator/merge-results.ts` exactly to the Phase 1 API. Build successful quotes by source, preserve provider failure errors, create one `currency_mismatch` `JobError` per source with message `Cannot compare USD with KRW`, choose Google on `<=`, and return `[...rows].sort(...)` so callers are not mutated.

The key best selection must be:

```ts
const best =
  googleQuote && naverQuote
    ? googleQuote.price <= naverQuote.price
      ? { ...googleQuote, source: "google" as const }
      : { ...naverQuote, source: "naver" as const }
    : googleQuote
      ? { ...googleQuote, source: "google" as const }
      : { ...naverQuote!, source: "naver" as const };
```

Do not accept `cancelled` outcomes in this function; throw `Error("cancelled pair cannot be merged")` if either outcome is cancelled. This makes accidental `completedPairs` increments observable.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/orchestrator/merge-results.test.ts && npm run typecheck`

Expected: 5 tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/merge-results.ts tests/orchestrator/merge-results.test.ts
git commit -m "feat: merge and sort provider outcomes"
```

## Task 3: Build reusable source-wide schedulers

**Files:**
- Create: `src/orchestrator/queue.ts`
- Create: `tests/orchestrator/queue.test.ts`

- [ ] **Step 1: Write failing queue tests**

Create tests that use deferred promises and assert the exact invariants:

```ts
import { describe, expect, it, vi } from "vitest";
import { SourceScheduler } from "../../src/orchestrator/queue.js";
import type { Quote } from "../../src/providers/types.js";

const quote: Quote = {
  price: 1,
  currency: "KRW",
  url: "https://example.test",
  scrapedAt: "2026-07-14T00:00:00.000Z",
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const activeToken = { shouldStop: () => false };
const noOpHooks = {
  beforeAttempt: async () => undefined,
  afterFailure: async () => undefined,
};

describe("SourceScheduler", () => {
  it("never exceeds source concurrency 2", async () => {
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 3 }, () => deferred<Quote>());
    const scheduler = new SourceScheduler({
      source: "google",
      concurrency: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0,
      sleep: async () => undefined,
      retryPolicy: { maxAttempts: 1, shouldRetry: () => false },
      limiterHooks: noOpHooks,
    });
    const outcomes = gates.map((gate) =>
      scheduler.add(async () => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          return await gate.promise;
        } finally {
          active -= 1;
        }
      }, activeToken),
    );
    await Promise.resolve();
    expect(peak).toBe(2);
    gates[0]!.resolve(quote);
    gates[1]!.resolve(quote);
    await Promise.resolve();
    gates[2]!.resolve(quote);
    await Promise.all(outcomes);
    expect(peak).toBe(2);
  });

  it("injects inclusive jitter before invoking a provider", async () => {
    const events: string[] = [];
    const scheduler = new SourceScheduler({
      source: "naver",
      concurrency: 1,
      minDelayMs: 500,
      maxDelayMs: 1500,
      random: () => 0.25,
      sleep: vi.fn(async (milliseconds) => {
        events.push(`sleep:${milliseconds}`);
      }),
      retryPolicy: { maxAttempts: 1, shouldRetry: () => false },
      limiterHooks: {
        beforeAttempt: async () => {
          events.push("beforeAttempt");
        },
        afterFailure: async () => undefined,
      },
    });
    await scheduler.add(async () => {
      events.push("provider");
      return quote;
    }, activeToken);
    expect(events).toEqual(["sleep:750", "beforeAttempt", "provider"]);
  });

  it("does not start queued work after cooperative cancellation", async () => {
    let cancelled = false;
    const gate = deferred<Quote>();
    const provider = vi.fn(async () => gate.promise);
    const scheduler = new SourceScheduler({
      source: "google",
      concurrency: 1,
      minDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0,
      sleep: async () => undefined,
      retryPolicy: { maxAttempts: 1, shouldRetry: () => false },
      limiterHooks: noOpHooks,
    });
    const token = { shouldStop: () => cancelled };
    const first = scheduler.add(provider, token);
    const second = scheduler.add(provider, token);
    await Promise.resolve();
    cancelled = true;
    gate.resolve(quote);
    await first;
    expect(await second).toEqual({ kind: "cancelled", source: "google" });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("attempts a failing cell once with the Phase 1 default policy", async () => {
    const afterFailure = vi.fn(async () => undefined);
    const provider = vi.fn(async () => {
      throw new Error("blocked");
    });
    const scheduler = new SourceScheduler({
      source: "naver",
      concurrency: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0,
      sleep: async () => undefined,
      retryPolicy: { maxAttempts: 1, shouldRetry: () => false },
      limiterHooks: {
        beforeAttempt: async () => undefined,
        afterFailure,
      },
    });
    const outcome = await scheduler.add(provider, activeToken);
    expect(outcome.kind).toBe("failure");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(afterFailure).toHaveBeenCalledWith("naver", expect.any(Error));
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/orchestrator/queue.test.ts`

Expected: FAIL with missing `queue.js`.

- [ ] **Step 3: Implement the queue**

Implement `SourceScheduler` with an internal FIFO array, `active` count, and idle waiters. `add` stores `{task, token, resolve}` and calls a synchronous `drain`; `drain` starts work while `active < concurrency`. Each worker checks `token.shouldStop()` before sleep, after sleep, after `limiterHooks.beforeAttempt(source)`, and immediately before each provider attempt. 실패 시 `afterFailure(source, error)`를 await한 뒤 retry policy를 평가한다. Scheduler는 pair 날짜를 모르므로 실패를 `cause`로 반환하고 orchestrator가 완전한 `JobError`를 만든다.

```ts
export type QueueOutcome =
  | { kind: "success"; source: ProviderId; quote: Quote }
  | { kind: "failure"; source: ProviderId; cause: unknown }
  | { kind: "cancelled"; source: ProviderId };

export class SourceScheduler {
  add(task: () => Promise<Quote>, token: ExecutionToken): Promise<QueueOutcome>;
}
```

In orchestrator, map `QueueOutcome.failure` to `CellOutcome.failure` with the pair dates, `provider_error`, normalized message, and injected timestamp. This explicit separation avoids fake dates and keeps file responsibilities focused.

- [ ] **Step 4: Verify GREEN and source isolation**

Run: `npm test -- tests/orchestrator/queue.test.ts && npm run typecheck`

Expected: 4 tests PASS; no timers or network remain active; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/queue.ts tests/orchestrator/queue.test.ts
git commit -m "feat: add shared per-source scheduler"
```

## Task 4: Persist jobs atomically and serially

**Files:**
- Create: `src/jobs/store.ts`
- Create: `tests/jobs/store.test.ts`

- [ ] **Step 1: Write failing round-trip, serialization, atomicity, and restart tests**

Create `tests/jobs/store.test.ts`. Use `mkdtemp(join(tmpdir(), "search-way-"))` in `beforeEach` and `rm(directory, { recursive: true, force: true })` in `afterEach`. Define a complete queued `SearchJob` fixture, then add:

```ts
it("round-trips a cloned job snapshot", async () => {
  await store.create(job);
  const read = await store.get(job.jobId);
  read.progress.completedPairs = 99;
  expect((await store.get(job.jobId)).progress.completedPairs).toBe(0);
});

it("serializes concurrent updates for one job without lost increments", async () => {
  await store.create(job);
  await Promise.all(
    Array.from({ length: 20 }, () =>
      store.update(job.jobId, (current) => ({
        ...current,
        progress: {
          ...current.progress,
          completedPairs: current.progress.completedPairs + 1,
        },
      })),
    ),
  );
  expect((await store.get(job.jobId)).progress.completedPairs).toBe(20);
});

it("leaves only the final json after atomic temp plus rename", async () => {
  await store.create(job);
  await store.update(job.jobId, (current) => ({ ...current, status: "running" }));
  expect((await readdir(directory)).sort()).toEqual([`${job.jobId}.json`]);
  expect(JSON.parse(await readFile(join(directory, `${job.jobId}.json`), "utf8"))).toMatchObject({
    jobId: job.jobId,
    status: "running",
  });
});

it("marks queued and running jobs interrupted after restart", async () => {
  await store.create(job);
  await store.create({ ...job, jobId: "completed-job", status: "completed" });
  const restarted = new JsonJobStore(directory, () => "2026-07-14T01:00:00.000Z");
  expect(await restarted.markInterrupted()).toBe(1);
  expect(await restarted.get(job.jobId)).toMatchObject({
    status: "failed",
    failureReason: "interrupted",
    updatedAt: "2026-07-14T01:00:00.000Z",
  });
  expect((await restarted.get("completed-job")).status).toBe("completed");
});

it("rejects traversal-shaped job ids", async () => {
  await expect(store.get("../outside")).rejects.toThrow("Invalid job id");
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/jobs/store.test.ts`

Expected: FAIL with missing `store.js`.

- [ ] **Step 3: Implement atomic JSON persistence**

Implement `JsonJobStore` using only `mkdir`, `readFile`, `readdir`, `rename`, `unlink`, and `writeFile` from `node:fs/promises`, `randomUUID` from `node:crypto`, and `join` from `node:path`.

Required write primitive:

```ts
private async writeAtomic(job: SearchJob): Promise<void> {
  await mkdir(this.directory, { recursive: true });
  const target = this.pathFor(job.jobId);
  const temporary = join(
    this.directory,
    `${job.jobId}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
```

Use `/^[A-Za-z0-9_-]+$/` before path construction. Implement `enqueue(jobId, operation)` so rejection does not poison later operations:

```ts
const previous = this.chains.get(jobId) ?? Promise.resolve();
const current = previous.catch(() => undefined).then(operation);
this.chains.set(jobId, current.then(() => undefined, () => undefined));
return current;
```

`markInterrupted` reads only filenames ending `.json`, parses each through `get`, and calls `update`; malformed JSON is a store error and must reject rather than silently skip.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/jobs/store.test.ts && npm run typecheck`

Expected: 5 tests PASS; temp directory contains no `.tmp` file; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/store.ts tests/jobs/store.test.ts
git commit -m "feat: persist jobs with atomic serialized writes"
```

## Task 5: Add deterministic provider test doubles

**Files:**
- Create: `tests/helpers/mock-provider.ts`
- Create: `tests/helpers/eventually.ts`

- [ ] **Step 1: Create a controllable mock provider**

Create `tests/helpers/mock-provider.ts`:

```ts
import type {
  FlightProvider,
  ProviderId,
  ProviderSearchInput,
  Quote,
} from "../../src/providers/types.js";

export interface PendingCall {
  input: ProviderSearchInput;
  resolve(quote: Quote): void;
  reject(error: unknown): void;
}

export class ControllableProvider implements FlightProvider {
  readonly calls: ProviderSearchInput[] = [];
  readonly pending: PendingCall[] = [];

  constructor(readonly id: ProviderId) {}

  findDirectRoundTrip(input: ProviderSearchInput): Promise<Quote> {
    this.calls.push(structuredClone(input));
    return new Promise<Quote>((resolve, reject) => {
      this.pending.push({ input: structuredClone(input), resolve, reject });
    });
  }

  resolveNext(price: number, currency = "KRW"): void {
    const call = this.pending.shift();
    if (!call) throw new Error(`No pending ${this.id} call`);
    call.resolve({
      price,
      currency,
      url: `https://${this.id}.example/${call.input.departureDate}`,
      scrapedAt: "2026-07-14T00:00:00.000Z",
    });
  }

  rejectNext(message: string): void {
    const call = this.pending.shift();
    if (!call) throw new Error(`No pending ${this.id} call`);
    call.reject(new Error(message));
  }
}

export class ImmediateProvider implements FlightProvider {
  readonly calls: ProviderSearchInput[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly result: (input: ProviderSearchInput) => Quote | Error,
  ) {}

  async findDirectRoundTrip(input: ProviderSearchInput): Promise<Quote> {
    this.calls.push(structuredClone(input));
    const value = this.result(input);
    if (value instanceof Error) throw value;
    return value;
  }
}
```

- [ ] **Step 2: Create a bounded polling helper**

Create `tests/helpers/eventually.ts`:

```ts
import { expect } from "vitest";

export async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  expect.fail(`eventually timed out: ${String(lastError)}`);
}
```

- [ ] **Step 3: Verify helpers compile through their first consumers**

Run: `npm run typecheck`

Expected: exit 0. Helpers are under `tests/` and excluded by the production tsconfig, so also run `npm test -- tests/orchestrator/queue.test.ts` to force Vitest/esbuild compilation; expected PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/mock-provider.ts tests/helpers/eventually.ts
git commit -m "test: add deterministic provider doubles"
```

## Task 6: Orchestrate two cells per pair and persist partial progress

**Files:**
- Create: `src/orchestrator/index.ts`
- Create: `tests/orchestrator/orchestrator.test.ts`

- [ ] **Step 1: Write the failing pair-barrier and partial-sort tests**

In `tests/orchestrator/orchestrator.test.ts`, create a fresh `JsonJobStore` temp directory per test, inject fixed IDs, `minDelayMs: 0`, `maxDelayMs: 0`, and two `ControllableProvider`s. Use three fixed pairs.

Assert:

```ts
const started = await orchestrator.start(request);
expect(started).toEqual({ jobId: "job-1", totalPairs: 3, status: "queued" });

await eventually(() => {
  expect(google.calls).toHaveLength(2);
  expect(naver.calls).toHaveLength(2);
});
expect((await orchestrator.getStatus("job-1")).status).toBe("running");

google.resolveNext(200_000);
await Promise.resolve();
expect((await orchestrator.getStatus("job-1")).progress.completedPairs).toBe(0);

naver.resolveNext(190_000);
await eventually(async () => {
  const status = await orchestrator.getStatus("job-1");
  expect(status.progress.completedPairs).toBe(1);
  expect(status.results.map((row) => row.best.price)).toEqual([190_000]);
});
```

Add a dedicated ordering case whose provider double executes `observedStatuses.push((await store.get("running-order")).status)` as its first line. Block the provider afterward and assert:

```ts
await eventually(() => {
  expect(observedStatuses).toEqual(["running", "running"]);
});
```

This directly proves the atomic queued → running update completed before either provider invocation, rather than relying on a later poll. Then resolve the remaining calls with prices in reverse order, wait for idle, and assert final prices are sorted ascending, `completedPairs===3`, `googleOk===3`, `naverOk===3`, and both providers received every pair exactly once.

- [ ] **Step 2: Write the failing failure-accounting test**

Use three pairs:

1. Google success + Naver failure → result row, not failed pair.
2. Google failure + Naver failure → no row, `failedPairs + 1`.
3. Google USD success + Naver KRW success → no row, `failedPairs + 1`, two `currency_mismatch` errors.

After `waitForIdle`, assert `status==="completed"`, `completedPairs===3`, `failedPairs===2`, `results.length===1`, `googleOk===2`, `naverOk===1`, and provider failures plus mismatch errors remain in `errors`.

- [ ] **Step 3: Verify RED**

Run: `npm test -- tests/orchestrator/orchestrator.test.ts`

Expected: FAIL with missing `src/orchestrator/index.js`.

- [ ] **Step 4: Implement lifecycle and pair barriers**

Implement `createSearchOrchestrator` with:

1. dependency validation: `google.id==="google"` and `naver.id==="naver"`;
2. factory scope에서 한 번만 만든 `googleScheduler`와 `naverScheduler`;
3. in-memory `Map<string, Runtime>` where `Runtime` is:

```ts
interface Runtime {
  cancellationRequested: boolean;
  fatal: unknown | null;
  run: Promise<void>;
  settled: boolean;
  settledAt: number | null;
}
```

4. queued `SearchJob` creation using injected `now`;
5. execution 시작 시 `store.update`로 queued만 running으로 전환하고, update가 resolve된 뒤에만 cell 등록;
6. 모든 task에 같은 job runtime을 읽는 `{ shouldStop: () => runtime.cancellationRequested || runtime.fatal !== null }` token 전달;
7. 모든 pair의 Google/Naver `scheduler.add`를 등록한 뒤 각 pair Promise가 두 outcome을 기다림;
8. pair Promise가 cancellation outcome을 제외하고 queue failure를 완전한 `JobError`로 변환한 뒤 `mergePair`와 한 번의 `store.update` 수행;
9. `Promise.all(pairPromises)` 후 current가 running일 때만 completed로 전환;
10. 모든 store operation을 `persist(runtime, operation)` helper로 감싸 첫 failure에서 `runtime.fatal ??= error`와 `runtime.cancellationRequested=true`를 동기적으로 설정한 뒤 rethrow;
11. top-level catch에서 fatal token을 유지하고 가능한 경우 `failed/store_error`를 저장한 뒤 원래 run Promise를 reject;
12. run settle 시 runtime을 삭제하지 않고 `settled=true`, `settledAt=Date.now()`로 표시하고 retention 정책을 실행.

Running transition mutator는 terminal 상태를 되돌리지 않는다:

```ts
await persist(runtime, () =>
  store.update(jobId, (current) =>
    current.status === "queued"
      ? { ...current, status: "running", updatedAt: config.now() }
      : current,
  ),
);
if (runtime.cancellationRequested || runtime.fatal !== null) return;
```

The atomic pair update must append errors, append a non-null row, call `sortResults`, increment `completedPairs` exactly once, and add merge counters. Preserve `cancelled` status and reject updates after failed/completed:

```ts
if (current.status === "failed" || current.status === "completed") return current;
return {
  ...current,
  updatedAt: config.now(),
  progress: {
    ...current.progress,
    completedPairs: current.progress.completedPairs + 1,
    failedPairs: current.progress.failedPairs + (merged.failed ? 1 : 0),
    googleOk: current.progress.googleOk + merged.googleOk,
    naverOk: current.progress.naverOk + merged.naverOk,
  },
  results: sortResults(
    merged.row ? [...current.results, merged.row] : current.results,
  ),
  errors: [...current.errors, ...merged.errors],
};
```

Normalize unknown provider errors with:

```ts
const message = cause instanceof Error ? cause.message : String(cause);
```

Do not classify timeout/blocked/no-direct-flight yet; Phase 4 owns taxonomy strengthening.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- tests/orchestrator/orchestrator.test.ts && npm run typecheck`

Expected: pair-barrier and failure-accounting tests PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/index.ts tests/orchestrator/orchestrator.test.ts
git commit -m "feat: orchestrate pair progress and partial results"
```

## Task 7: Prove source isolation and orchestrator-wide limits

**Files:**
- Modify: `tests/orchestrator/orchestrator.test.ts`
- Modify only if a test exposes a defect: `src/orchestrator/index.ts`, `src/orchestrator/queue.ts`

- [ ] **Step 1: Add an independent-source progress test**

Start 4 pairs with controllable providers and concurrency 2. Resolve both initial Google calls while leaving Naver blocked. Assert Google immediately receives calls 3 and 4 while Naver remains at 2 calls. Then resolve Naver and complete the job.

Expected evidence:

```ts
expect(google.calls).toHaveLength(4);
expect(naver.calls).toHaveLength(2);
expect((await orchestrator.getStatus("job-1")).progress.completedPairs).toBe(0);
```

This proves Google capacity is not held by Naver and pair progress still waits for both.

- [ ] **Step 2: Add a two-job global limiter test**

Create two 4-pair jobs on the same orchestrator instance. Use provider doubles that increment `active` before awaiting a deferred provider gate and decrement in `finally`. Inject one `SourceLimiterHooks` object with source-keyed gates, initially holding only Google. After both jobs start, assert:

```ts
expect(google.calls).toHaveLength(0);
expect(naver.calls).toHaveLength(2);
expect(naverPeak).toBe(2);
```

Release the Google limiter gate, poll until exactly two Google provider calls start, then assert `googlePeak===2`. Release every deferred provider call, await both job IDs, then assert:

```ts
expect(googlePeak).toBe(2);
expect(naverPeak).toBe(2);
```

This demonstrates the Phase 4 seam: one source pause gate is consulted by cells from every job sharing the orchestrator, without pausing the other source.

이 테스트는 scheduler를 `start` 안에서 만들면 두 job 합산 peak가 4가 되어 RED가 된다.

- [ ] **Step 3: Run the source scheduler tests and verify RED**

Run: `npm test -- tests/orchestrator/orchestrator.test.ts -t "source|two jobs"`

Expected before correction: two-job test FAILS with provider peak 4 if scheduler ownership is job scope.

- [ ] **Step 4: Move scheduler ownership to factory scope**

Create the two scheduler instances before the returned orchestrator object:

```ts
const googleScheduler = new SourceScheduler({
  source: "google",
  concurrency: config.concurrencyPerSource,
  minDelayMs: config.minDelayMs,
  maxDelayMs: config.maxDelayMs,
  random: config.random,
  sleep: config.sleep,
  retryPolicy: config.retryPolicy,
  limiterHooks: config.limiterHooks,
});
const naverScheduler = new SourceScheduler({
  source: "naver",
  concurrency: config.concurrencyPerSource,
  minDelayMs: config.minDelayMs,
  maxDelayMs: config.maxDelayMs,
  random: config.random,
  sleep: config.sleep,
  retryPolicy: config.retryPolicy,
  limiterHooks: config.limiterHooks,
});
```

Every `start` closes over these same schedulers. Do not instantiate a scheduler inside `start` or `execute`.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- tests/orchestrator/orchestrator.test.ts -t "source|two jobs" && npm run typecheck`

Expected: source independence passes; the shared Google pause initially blocks both jobs only on Google; two concurrent jobs finish with Google peak 2 and Naver peak 2.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/index.ts src/orchestrator/queue.ts tests/orchestrator/orchestrator.test.ts
git commit -m "fix: share source schedulers across jobs"
```

## Task 8: Guard cancellation, fatal persistence, and runtime observation

**Files:**
- Modify: `tests/orchestrator/orchestrator.test.ts`
- Modify: `src/orchestrator/index.ts`
- Modify only if task-token checks are incomplete: `src/orchestrator/queue.ts`

- [ ] **Step 1: Add a cooperative cancellation test**

Start 10 pairs, wait until each provider has exactly 2 in-flight calls, call `cancel("job-1")`, then resolve those four in-flight calls. Await idle and assert:

```ts
expect(status.status).toBe("cancelled");
expect(status.cancellationRequested).toBe(true);
expect(google.calls).toHaveLength(2);
expect(naver.calls).toHaveLength(2);
expect(status.progress.completedPairs).toBe(2);
expect(status.results).toHaveLength(2);
```

Also assert the remaining 8 pairs do not increment `failedPairs` and no cancellation error is appended.

- [ ] **Step 2: Add terminal and repeated cancel guards**

Cover all terminal states with exact snapshots:

```ts
const completedBefore = await orchestrator.getStatus("completed-job");
expect(await orchestrator.cancel("completed-job")).toEqual(completedBefore);

const failedBefore = await orchestrator.getStatus("failed-job");
expect(await orchestrator.cancel("failed-job")).toEqual(failedBefore);

const firstCancel = await orchestrator.cancel("running-job");
const repeatedCancel = await orchestrator.cancel("running-job");
expect(repeatedCancel).toEqual(firstCancel);
expect(repeatedCancel.updatedAt).toBe(firstCancel.updatedAt);
```

Create the failed fixture through `recoverInterrupted` or a controlled store failure; do not edit shared job types. The cancel mutator must be:

```ts
const runtime = runtimes.get(jobId);
if (runtime) runtime.cancellationRequested = true;
return store.update(jobId, (current) => {
  if (
    current.status === "completed" ||
    current.status === "failed" ||
    current.status === "cancelled"
  ) {
    return current;
  }
  return {
    ...current,
    status: "cancelled",
    cancellationRequested: true,
    updatedAt: config.now(),
  };
});
```

Token은 provider 시작을 즉시 막고, serialized mutator의 terminal guard가 persisted terminal snapshot과 `updatedAt`을 그대로 보존한다.

- [ ] **Step 3: Add a fatal store-failure seam and test**

Define a test-only `FailOnceOnProgressStore extends JsonJobStore` that throws before writing the first snapshot whose `completedPairs` becomes 1, then delegates normally. Configure concurrency 1 and an injected sleep that lets the first Google/Naver task pass but holds each source's second task after it acquires the scheduler slot. Resolve the first pair, await `waitForIdle` rejection, release held sleeps, and assert no second provider call occurs:

```ts
await expect(orchestrator.waitForIdle("fatal-job")).rejects.toThrow(
  "injected progress write failure",
);
releaseHeldSleeps();
await Promise.resolve();
expect(google.calls).toHaveLength(1);
expect(naver.calls).toHaveLength(1);
```

The store double throws inside `super.update(jobId, current => { const next = mutate(current); ... })`, only once. This leaves the following best-effort `failed/store_error` update available. The test proves already-enqueued task records re-check the runtime fatal token after sleep and before provider invocation.

- [ ] **Step 4: Add settled/rejected wait and cleanup tests**

Assert all policies:

```ts
await orchestrator.waitForIdle("completed-job");
await orchestrator.waitForIdle("completed-job"); // settled Promise remains observable
expect(orchestrator.releaseRuntime("completed-job")).toBe(true);
expect(orchestrator.releaseRuntime("completed-job")).toBe(false);

await expect(orchestrator.waitForIdle("fatal-job")).rejects.toThrow(
  "injected progress write failure",
);
```

Create an orchestrator with `settledRuntimeLimit: 2`, finish three jobs without explicit release, and verify pruning only through the public lifecycle contract:

```ts
expect(orchestrator.releaseRuntime("oldest-job")).toBe(false);
await expect(orchestrator.waitForIdle("oldest-job")).resolves.toBeUndefined();
expect(orchestrator.releaseRuntime("middle-job")).toBe(true);
expect(orchestrator.releaseRuntime("newest-job")).toBe(true);
```

Do not expose the runtime map or add test-only production callbacks.

- [ ] **Step 5: Run the new tests and verify RED**

Run: `npm test -- tests/orchestrator/orchestrator.test.ts`

Expected before correction: tests fail if cancel overwrites terminal jobs, a pending provider starts after fatal store failure, settled rejection is lost, or runtime retention is unbounded.

- [ ] **Step 6: Implement runtime fatal and retention policy**

Use the original rejecting run Promise in the runtime map and attach a separate observer to avoid unhandled rejection:

```ts
runtime.run = execute(runtime);
void runtime.run.catch(() => undefined);
void runtime.run.finally(() => {
  runtime.settled = true;
  runtime.settledAt = Date.now();
  pruneSettledRuntimes();
}).catch(() => undefined);
```

All store writes in `execute` use this fatal helper:

```ts
async function persist<T>(
  runtime: Runtime,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (runtime.fatal === null) runtime.fatal = error;
    runtime.cancellationRequested = true;
    throw error;
  }
}
```

`pruneSettledRuntimes` deletes only settled entries, oldest `settledAt` first, until count is at most `settledRuntimeLimit`. `releaseRuntime` deletes only a settled entry. `waitForIdle` behavior:

```ts
const runtime = runtimes.get(jobId);
if (runtime) return runtime.run;
const snapshot = await store.get(jobId);
if (snapshot.status === "queued" || snapshot.status === "running") {
  throw new Error(`Runtime missing for active job ${jobId}`);
}
```

Terminal persisted jobs without retained runtime resolve. Unknown IDs still surface `JobNotFoundError`. No `AbortController` hard abort is required; already-started provider calls may finish, while pending cells stop on cancellation/fatal token.

- [ ] **Step 7: Verify GREEN**

Run: `npm test -- tests/orchestrator/orchestrator.test.ts && npm run typecheck`

Expected: all orchestrator tests PASS; terminal cancel snapshots are unchanged; fatal job starts no second cell; repeated wait observes the same settlement; retention never exceeds the configured bound.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/index.ts src/orchestrator/queue.ts tests/orchestrator/orchestrator.test.ts
git commit -m "fix: harden orchestrator terminal lifecycle"
```

## Task 9: Pass G4 with 50 mock pairs

**Files:**
- Modify: `tests/orchestrator/orchestrator.test.ts`
- Modify only if the gate reveals a defect: owned Phase 1 source files

- [ ] **Step 1: Add a 50-pair start/status/completion gate**

Generate exactly 50 deterministic pairs (`2026-10-01` through an index-based date fixture; dates only need valid contract strings because the combinator is injected). Use immediate providers, concurrency 2, zero jitter, and prices derived from input. Assert:

```ts
expect(await orchestrator.start(request)).toEqual({
  jobId: "g4-complete",
  totalPairs: 50,
  status: "queued",
});
await orchestrator.waitForIdle("g4-complete");
const status = await orchestrator.getStatus("g4-complete");
expect(status.status).toBe("completed");
expect(status.progress).toEqual({
  totalPairs: 50,
  completedPairs: 50,
  failedPairs: 0,
  googleOk: 50,
  naverOk: 50,
});
expect(status.results).toHaveLength(50);
expect(status.results.map((row) => row.best.price)).toEqual(
  [...status.results.map((row) => row.best.price)].sort((a, b) => a - b),
);
expect(google.calls).toHaveLength(50);
expect(naver.calls).toHaveLength(50);
```

- [ ] **Step 2: Add a 50-pair partial-status gate**

Use controllable providers. Start 50 pairs, resolve the first two calls from both sources, and poll until `completedPairs===2`. Assert status remains `running`, results has 2 sorted rows, and each source has started the next two cells. Then resolve all pending calls in a loop until idle and assert 50/50 completion.

- [ ] **Step 3: Add a 50-pair cancel gate**

Start 50 pairs, wait for 2 calls per source, cancel, resolve only those in-flight calls, and await idle. Assert `cancelled`, `completedPairs===2`, partial results preserved, call counts remain 2 per source, and 48 unstarted pairs are neither completed nor failed.

- [ ] **Step 4: Run G4 and verify GREEN**

Run: `npm test -- tests/orchestrator/orchestrator.test.ts -t "G4"`

Expected: all three G4 tests PASS: start/status completion, increasing partial status, and cooperative cancel over 50 pairs.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/index.ts src/orchestrator/queue.ts src/orchestrator/merge-results.ts src/jobs/store.ts tests/orchestrator/orchestrator.test.ts
git commit -m "test: pass 50-pair orchestrator G4"
```

## Task 10: Verify restart recovery through orchestrator

**Files:**
- Modify: `tests/orchestrator/orchestrator.test.ts`
- Modify only if required: `src/orchestrator/index.ts`, `src/jobs/store.ts`

- [ ] **Step 1: Add the failing recovery delegation test**

Persist one queued, one running, and one completed job directly. Construct a new orchestrator over a new `JsonJobStore` instance pointing at the same directory, call `recoverInterrupted`, and assert:

```ts
expect(await restarted.recoverInterrupted()).toBe(2);
expect(await restarted.getStatus("queued-job")).toMatchObject({
  status: "failed",
  failureReason: "interrupted",
});
expect(await restarted.getStatus("running-job")).toMatchObject({
  status: "failed",
  failureReason: "interrupted",
});
expect((await restarted.getStatus("completed-job")).status).toBe("completed");
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/orchestrator/orchestrator.test.ts -t "interrupted"`

Expected: FAIL if `recoverInterrupted` is absent or does not delegate to `store.markInterrupted`.

- [ ] **Step 3: Add the minimal delegation**

```ts
recoverInterrupted: () => dependencies.store.markInterrupted(),
```

Do not auto-resume provider calls. Restart semantics are terminal `failed/interrupted`.

- [ ] **Step 4: Run full Phase 1 verification**

Run:

```bash
npm test -- tests/orchestrator tests/jobs
npm run typecheck
npm run build
```

Expected: all Phase 1 tests PASS, typecheck/build exit 0, and no live network request occurs.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/index.ts src/jobs/store.ts tests/orchestrator/orchestrator.test.ts
git commit -m "feat: recover interrupted persisted jobs"
```

## Verification

Run from `C:\Users\hwang\github\search-way`:

```bash
npm test -- tests/orchestrator/config.test.ts
npm test -- tests/orchestrator/merge-results.test.ts
npm test -- tests/orchestrator/queue.test.ts
npm test -- tests/jobs/store.test.ts
npm test -- tests/orchestrator/orchestrator.test.ts
npm test -- tests/orchestrator tests/jobs
npm run typecheck
npm run build
```

Expected:

- every command exits 0;
- G4 output reports three passing 50-pair tests;
- provider call records prove both sources attempted every non-cancelled pair;
- peak concurrency is 2 independently for Google and Naver;
- two simultaneous jobs share those limits, so each provider's aggregate peak remains 2;
- every provider call observes a persisted `running` snapshot first;
- `completedPairs` changes only after both cell outcomes settle;
- one-source failure produces a partial row; both-source failure and currency mismatch increment `failedPairs`;
- every status snapshot has results sorted by `best.price`, and equal quote prices choose Google;
- cancel starts no queued cell, preserves already completed pairs, and cannot overwrite terminal jobs;
- first fatal store failure prevents every not-yet-started cell from calling its provider;
- settled/rejected run Promises remain observable until explicit or bounded cleanup;
- JSON round-trip, 20 concurrent updates, no leftover temp file, and interrupted restart tests pass;
- no Google/Naver live network request occurs.

## Output

Implementing agent must report:

- changed files, grouped by source/tests;
- every RED command and its expected failure reason;
- every GREEN/full verification command and pass count;
- G4 evidence: total pairs, completed/failed counts, per-source call counts, partial-status observation, cancel call counts;
- two-job global limiter peak, queued→running ordering, terminal/repeated cancel, fatal-call cutoff, and runtime-retention evidence;
- JSON store evidence: concurrent increment result, final filenames, interrupted count;
- any mismatch in shared contracts or Phase 0 `generateDatePairs` export;
- `BLOCKED` instead of modifying a forbidden file;
- commit hashes/messages for the frequent commits above.

No placeholders, skipped tests, `.only`, live provider calls, broad `any`, fabricated quotes, or shared-contract edits are permitted.
