# Flexible Flight Search Phase 3 MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 검증된 core를 얇은 MCP 경계로 노출하여 `start_flexible_search`, `get_search_status`, `cancel_search`와 stdio 서버를 구현하고, 네트워크 없는 in-process 및 built stdio smoke로 계약을 증명한다.

**Architecture:** `validation.ts`가 외부 snake_case 입력을 정규화된 내부 camelCase 타입으로 바꾸고, `tools.ts`가 Phase 1 `SearchOrchestrator`와 `generateDatePairs`에 바로 연결되는 transport-independent handler를 제공한다. `serialization.ts`는 내부 job snapshot을 외부 snake_case JSON으로 복사·정렬하며, `server.ts`만 설치된 MCP SDK의 실제 API와 stdio transport를 사용한다. MCP는 zero-pair precheck 뒤 `SearchOrchestrator.start(request)`를 정확히 한 번 호출하며, queued 저장·background 예약·background rejection 처리는 Phase 1 orchestrator가 전담한다.

**Tech Stack:** Node.js 20+, TypeScript ESM/NodeNext, Zod, Vitest, 설치된 `@modelcontextprotocol/sdk`, child process stdio

---

## Ownership

이 Phase 구현자가 생성하거나 수정할 수 있는 파일은 아래뿐이다.

- `src/mcp/validation.ts`
- `src/mcp/serialization.ts`
- `src/mcp/tools.ts`
- `src/mcp/server.ts`
- `tests/mcp/validation.test.ts`
- `tests/mcp/serialization.test.ts`
- `tests/mcp/tools.test.ts`
- `tests/mcp/server.test.ts`
- `tests/mcp/stdio-smoke.test.ts`

## Forbidden Writes

- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`
- `src/domain/**`
- `src/jobs/**`
- `src/orchestrator/**`
- `src/providers/**`
- `tests/domain/**`, `tests/jobs/**`, `tests/orchestrator/**`, `tests/providers/**`
- `scripts/**`, `data/**`, `.env*`
- 이 문서를 제외한 `docs/**`

core 또는 package 계약이 부족하면 해당 파일을 고치지 말고 `BLOCKED`와 필요한 export/signature를 보고한다.

## Dependencies

- `docs/superpowers/specs/2026-07-14-flexible-flight-search-design.md`가 제품 계약의 source of truth다.
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-contracts.md`의 `FlexibleSearchRequest`, `DatePair`, `Quote`, `SearchJob` 타입을 그대로 import한다.
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-master.md`의 Phase 0~2 exit gate가 모두 통과해야 시작한다.
- Phase 0는 `generateDatePairs(request: FlexibleSearchRequest): DatePair[]`를 export한다.
- Phase 1은 `createSearchOrchestrator(dependencies): SearchOrchestrator`와 `SearchOrchestrator.start`, `getStatus`, `cancel`, `waitForIdle`, `recoverInterrupted`를 export한다. `start`가 queued job 저장과 background 실행 예약을 모두 소유한다.
- Phase 1은 production/offline 조립에 쓰는 `JsonJobStore`와 `OrchestratorDependencies`를 export한다.
- Phase 2는 `GoogleFlightProvider`와 `NaverFlightProvider` 및 각 constructor에 필요한 실제 selected-mode client 구현을 export해야 한다. 구현 시작 전 Task 0에서 source의 실제 class/export 이름과 constructor signature를 확인한다.
- 테스트는 offline mock dependencies만 사용하며 Google/Naver live 요청을 하지 않는다.

## Contract

### 외부 도구

1. `start_flexible_search`
   - 입력: 설계 문서의 snake_case 구조
   - IATA는 trim 후 대문자로 정규화한다.
   - months는 중복 제거 후 정렬하고 실제 달인지 검증하며 unique 개수가 1..3이어야 한다.
   - `min_trip_days`는 정수 2..30, `max_trip_days`는 정수 2..30이고 `max >= min`이다.
   - weekday는 중복 제거·정렬하며 각 값은 정수 0..6이다. 생략/빈 배열은 내부에서 `[]`다.
   - 알 수 없는 입력 key는 거부한다.
   - date pair가 0개면 `EMPTY_DATE_PAIRS`를 반환하고 job을 만들지 않는다.
   - `enumerateDatePairs(request)`가 1개 이상임을 확인한 뒤 `core.start(request)`를 정확히 한 번 await하고 `{ job_id, total_pairs, status: "queued" }`로 직렬화한다.
   - queued 저장·background 실행 예약·background rejection 관찰은 Phase 1 `SearchOrchestrator.start` 내부 책임이다. MCP는 별도 실행 scheduler를 추가하지 않는다.
   - `core.start(request)` 자체가 reject하면 job 내부 상태를 추측하거나 다시 시작하지 않고 `INTERNAL_ERROR`로 매핑한다.
2. `get_search_status`
   - 입력: `{ job_id: string }`
   - 조회 자체는 상태를 변경하지 않는 멱등 read다.
   - partial/final snapshot 모두 반환하며 results 복사본을 `best.price`, `departure_date`, `return_date` 순으로 안정 정렬한다.
   - 내부 camelCase를 외부 snake_case로 재귀적으로 매핑한다.
   - 내부 `JobError`는 `departure_date`, `return_date`, `source`, `message`, `at`으로 매핑한다. 설계의 외부 계약에 없는 내부 `code`는 노출하지 않는다.
   - 없는 ID는 MCP error payload `{"error":{"code":"JOB_NOT_FOUND","message":"Unknown job_id: " + jobId}}`다.
3. `cancel_search`
   - 입력: `{ job_id: string }`
   - queued/running은 cooperative cancellation flag를 요청하며 이미 완료된 부분 결과는 보존한다.
   - cancelled를 다시 cancel하면 동일한 cancelled 결과를 반환한다.
   - completed/failed는 terminal 상태를 바꾸지 않는다.
   - 성공 payload는 `{ job_id, status }`다.
   - 없는 ID는 `JOB_NOT_FOUND`다.

### transport-independent 결과

`tools.ts`의 handler는 SDK 객체를 직접 반환하지 않고 다음 내부 결과를 반환한다.

```ts
export type JsonObject = Record<string, unknown>;

export type ToolResult =
  | { ok: true; value: JsonObject }
  | {
      ok: false;
      error: {
        code: "INVALID_INPUT" | "EMPTY_DATE_PAIRS" | "JOB_NOT_FOUND" | "INTERNAL_ERROR";
        message: string;
      };
    };
```

`server.ts`가 이를 설치된 SDK의 성공 content/error 형태로 한 번만 변환한다. JSON text는 `JSON.stringify`한 단일 `text` content여야 하며 stdout에는 MCP protocol 외 로그를 쓰지 않는다.

### 공개 MCP 내부 의존성

`tools.ts`의 경계는 Phase 1 공개 API와 이름·signature를 맞추며, zero-pair precheck를 위한 Phase 0 함수만 추가한다.

```ts
import type { DatePair, FlexibleSearchRequest } from "../domain/types.js";
import type { SearchJob } from "../jobs/types.js";
import type { StartSearchResult } from "../orchestrator/index.js";

export interface McpCore {
  enumerateDatePairs(request: FlexibleSearchRequest): DatePair[];
  start(request: FlexibleSearchRequest): Promise<StartSearchResult>;
  getStatus(jobId: string): Promise<SearchJob>;
  cancel(jobId: string): Promise<SearchJob>;
  waitForIdle(jobId: string): Promise<void>;
  recoverInterrupted(): Promise<number>;
}
```

production wiring은 `createSearchOrchestrator(...)` 반환 객체의 다섯 method를 그대로 위임하고 `enumerateDatePairs: generateDatePairs`만 결합한다. `start` 결과가 `status !== "queued"`이거나 `totalPairs`가 precheck 결과 길이와 다르면 `INTERNAL_ERROR`로 처리하되 재호출·취소·별도 실행을 하지 않는다.

## File Map

- `src/mcp/validation.ts`: Zod schema, 외부 입력 정규화, 내부 타입 변환
- `src/mcp/serialization.ts`: 내부 camelCase snapshot을 외부 snake_case JSON으로 순수 변환 및 정렬
- `src/mcp/tools.ts`: zero-pair precheck와 Phase 1 start/getStatus/cancel 위임, 오류 매핑
- `src/mcp/server.ts`: 설치된 SDK 실제 API binding, production core/provider 조립, stdio entrypoint
- `tests/mcp/validation.test.ts`: normalization 및 모든 reject-before-job 경계
- `tests/mcp/serialization.test.ts`: nested field mapping, partial/error mapping, stable sorting, 비변이성
- `tests/mcp/tools.test.ts`: Phase 1-shaped fake core로 zero-pair, 단일 start 위임, start rejection, status/cancel 매핑 검증
- `tests/mcp/server.test.ts`: in-process server의 tools/list 및 call smoke
- `tests/mcp/stdio-smoke.test.ts`: build 산출물을 child process로 실행해 tools/list 확인

## Task 0: Verify Installed SDK and Core APIs

**Files:**
- Inspect only: `package.json`
- Inspect only: `package-lock.json`
- Inspect only: `node_modules/@modelcontextprotocol/sdk/**/*.d.ts`
- Inspect only: `src/domain/date-combinator.ts`
- Inspect only: `src/orchestrator/**`
- Inspect only: `src/jobs/**`
- Inspect only: `src/providers/**`

- [ ] **Step 1: Confirm package and installed version**

Run:

```bash
node --version
npm ls @modelcontextprotocol/sdk zod --depth=0
node --input-type=module -e "import fs from 'node:fs'; for (const p of ['node_modules/@modelcontextprotocol/sdk/package.json','node_modules/zod/package.json']) { const x=JSON.parse(fs.readFileSync(p,'utf8')); console.log(x.name, x.version); }"
```

Expected: Node is `v20` or newer; npm lists exactly one installed SDK and Zod version; the final command prints those same package versions. Missing packages are `BLOCKED` because this Phase may not edit package files.

- [ ] **Step 2: Inspect runtime exports and declaration signatures**

Run:

```bash
node --input-type=module -e "const sdk=await import('@modelcontextprotocol/sdk/server/index.js'); console.log(Object.keys(sdk).sort())"
node --input-type=module -e "const stdio=await import('@modelcontextprotocol/sdk/server/stdio.js'); console.log(Object.keys(stdio).sort())"
node --input-type=module -e "const client=await import('@modelcontextprotocol/sdk/client/index.js'); console.log(Object.keys(client).sort())"
node --input-type=module -e "const mem=await import('@modelcontextprotocol/sdk/inMemory.js').catch(e=>({unavailable:e.code??e.message})); console.log(mem.unavailable??Object.keys(mem).sort())"
rg -n "class (McpServer|Server|Client|StdioServerTransport|StdioClientTransport)|registerTool|setRequestHandler|listTools|callTool|InMemoryTransport" node_modules/@modelcontextprotocol/sdk --glob "*.d.ts"
```

Expected: commands exit 0 except that the explicitly caught optional in-memory import may print `unavailable`. Record the exact import paths, constructors, registration method, tool result type, client list/call methods, and paired in-memory transport availability in implementation notes before writing `server.ts` tests.

Do not copy API names from this plan into code unless the installed declarations/export checks confirm them. If no SDK-provided in-memory transport exists, use the verified low-level SDK transport pair or direct registered handler harness supported by that installed version; do not invent `InMemoryTransport`.

- [ ] **Step 3: Verify completed core exports**

Run:

```bash
rg -n "export (class|function|interface|type|const)|generateDatePairs|createSearchOrchestrator|start\\(|getStatus\\(|cancel\\(|waitForIdle\\(|recoverInterrupted\\(|JsonJobStore|GoogleFlightProvider|NaverFlightProvider|SourceClient" src/domain src/orchestrator src/jobs src/providers --glob "*.ts"
npm run typecheck
npm test
```

Expected:

- `src/domain/date-combinator.ts` exports `generateDatePairs(request)`;
- `src/orchestrator/index.ts` exports `createSearchOrchestrator`, `StartSearchResult`, `SearchOrchestrator`, and `OrchestratorDependencies`;
- `SearchOrchestrator` exposes `start`, `getStatus`, `cancel`, `waitForIdle`, `recoverInterrupted`;
- `src/jobs/store.ts` exports `JsonJobStore`;
- `src/providers/google/provider.ts` exports `GoogleFlightProvider`, and `src/providers/naver/provider.ts` exports `NaverFlightProvider`;
- each provider's actual constructor dependency is constructible from the selected-mode `client.ts` exports without modifying provider files;
- `createSearchOrchestrator({ google, naver, store, generateDatePairs, createJobId, config })` is possible using those actual constructors;
- typecheck and the full offline suite pass.

Record the exact Google/Naver client class/factory names and constructor arguments found in source; do not assume a client constructor name from the Phase 2 plan. If any dependency cannot be constructed through public exports, stop with `BLOCKED` and name the exact missing export/signature.

## Task 1: Validate and Normalize Tool Inputs

**Files:**
- Create: `tests/mcp/validation.test.ts`
- Create: `src/mcp/validation.ts`

- [ ] **Step 1: Write failing validation tests**

Create `tests/mcp/validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  jobIdInputSchema,
  startFlexibleSearchInputSchema,
} from "../../src/mcp/validation.js";

const validInput = {
  origin: " icn ",
  destination: "nrt",
  months: ["2026-10"],
  min_trip_days: 2,
  max_trip_days: 7,
};

describe("startFlexibleSearchInputSchema", () => {
  it("normalizes external snake_case input to the internal contract", () => {
    expect(
      startFlexibleSearchInputSchema.parse({
        ...validInput,
        months: ["2026-11", "2026-10", "2026-11"],
        departure_weekdays: [6, 1, 6],
        return_weekdays: [],
      }),
    ).toEqual({
      origin: "ICN",
      destination: "NRT",
      months: ["2026-10", "2026-11"],
      minTripDays: 2,
      maxTripDays: 7,
      departureWeekdays: [1, 6],
      returnWeekdays: [],
    });
  });

  it.each([
    [{ ...validInput, origin: "SEOUL" }, "IATA"],
    [{ ...validInput, months: [] }, "month"],
    [{ ...validInput, months: ["2026-00"] }, "month"],
    [{ ...validInput, months: ["2026-13"] }, "month"],
    [{ ...validInput, months: ["2026-01", "2026-02", "2026-03", "2026-04"] }, "month"],
    [{ ...validInput, min_trip_days: 1 }, "trip"],
    [{ ...validInput, min_trip_days: 8, max_trip_days: 7 }, "trip"],
    [{ ...validInput, max_trip_days: 31 }, "trip"],
    [{ ...validInput, departure_weekdays: [-1] }, "weekday"],
    [{ ...validInput, return_weekdays: [7] }, "weekday"],
    [{ ...validInput, departure_weekdays: [1.5] }, "weekday"],
    [{ ...validInput, unexpected: true }, "unrecognized"],
  ])("rejects invalid input before job creation: %j", (input) => {
    expect(startFlexibleSearchInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("jobIdInputSchema", () => {
  it("trims a non-empty job_id", () => {
    expect(jobIdInputSchema.parse({ job_id: " 01J0123456789ABCDEFGHJKMNP " }))
      .toEqual({ jobId: "01J0123456789ABCDEFGHJKMNP" });
  });

  it("rejects empty and unknown keys", () => {
    expect(jobIdInputSchema.safeParse({ job_id: " " }).success).toBe(false);
    expect(jobIdInputSchema.safeParse({ job_id: "x", extra: 1 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/mcp/validation.test.ts`

Expected: FAIL because `src/mcp/validation.ts` does not exist.

- [ ] **Step 3: Implement the exact Zod schemas**

Create `src/mcp/validation.ts`:

```ts
import { z } from "zod";
import type { FlexibleSearchRequest } from "../domain/types.js";

const iataSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/, "IATA code must contain exactly three letters"));

const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be a valid YYYY-MM");

const uniqueSorted = <T extends string | number>(values: readonly T[]): T[] =>
  [...new Set(values)].sort((left, right) =>
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right)),
  );

const monthsSchema = z
  .array(monthSchema)
  .transform(uniqueSorted)
  .pipe(z.array(monthSchema).min(1).max(3));

const weekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .default([])
  .transform(uniqueSorted);

export const startFlexibleSearchInputSchema = z
  .object({
    origin: iataSchema,
    destination: iataSchema,
    months: monthsSchema,
    min_trip_days: z.number().int().min(2).max(30),
    max_trip_days: z.number().int().min(2).max(30),
    departure_weekdays: weekdaysSchema,
    return_weekdays: weekdaysSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.max_trip_days < value.min_trip_days) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_trip_days"],
        message: "max_trip_days must be greater than or equal to min_trip_days",
      });
    }
  })
  .transform(
    (value): FlexibleSearchRequest => ({
      origin: value.origin,
      destination: value.destination,
      months: value.months,
      minTripDays: value.min_trip_days,
      maxTripDays: value.max_trip_days,
      departureWeekdays: value.departure_weekdays,
      returnWeekdays: value.return_weekdays,
    }),
  );

export const jobIdInputSchema = z
  .object({ job_id: z.string().trim().min(1) })
  .strict()
  .transform(({ job_id }) => ({ jobId: job_id }));
```

`monthsSchema`의 max 검사는 dedupe 뒤에 적용하므로 입력 중복은 허용하되 unique month가 4개면 거부한다.

- [ ] **Step 4: Run GREEN and typecheck**

Run: `npm test -- tests/mcp/validation.test.ts && npm run typecheck`

Expected: validation tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/validation.ts tests/mcp/validation.test.ts
git commit -m "feat: validate and normalize MCP search inputs"
```

## Task 2: Serialize Job Snapshots to snake_case

**Files:**
- Create: `tests/mcp/serialization.test.ts`
- Create: `src/mcp/serialization.ts`

- [ ] **Step 1: Write failing serialization tests**

Create `tests/mcp/serialization.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SearchJob } from "../../src/jobs/types.js";
import type { Quote } from "../../src/providers/types.js";
import { serializeSearchJob } from "../../src/mcp/serialization.js";

const quote = (price: number, scrapedAt: string): Quote => ({
  price,
  currency: "KRW",
  url: `https://example.test/${price}`,
  scrapedAt,
});

const makeJob = (): SearchJob => {
  const expensive = quote(300_000, "2026-07-14T00:00:20.000Z");
  const cheap = quote(200_000, "2026-07-14T00:00:30.000Z");
  return {
    jobId: "01JTEST",
    status: "running",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:01:00.000Z",
    request: {
      origin: "ICN",
      destination: "NRT",
      months: ["2026-10"],
      minTripDays: 2,
      maxTripDays: 4,
      departureWeekdays: [],
      returnWeekdays: [],
    },
    progress: {
      totalPairs: 3,
      completedPairs: 2,
      failedPairs: 1,
      googleOk: 1,
      naverOk: 1,
    },
    results: [
      {
        departureDate: "2026-10-01",
        returnDate: "2026-10-02",
        tripDays: 2,
        google: expensive,
        naver: null,
        best: { ...expensive, source: "google" },
      },
      {
        departureDate: "2026-10-02",
        returnDate: "2026-10-03",
        tripDays: 2,
        google: null,
        naver: cheap,
        best: { ...cheap, source: "naver" },
      },
    ],
    errors: [{
      departureDate: "2026-10-03",
      returnDate: "2026-10-04",
      source: "google",
      code: "provider_timeout",
      message: "timeout",
      at: "2026-07-14T00:00:40.000Z",
    }],
    cancellationRequested: false,
  };
};

describe("serializeSearchJob", () => {
  it("maps nested camelCase fields, errors, and sorted partial results", () => {
    const job = makeJob();
    const serialized = serializeSearchJob(job);

    expect(serialized).toMatchObject({
      job_id: "01JTEST",
      status: "running",
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:01:00.000Z",
      request: {
        origin: "ICN",
        destination: "NRT",
        months: ["2026-10"],
        min_trip_days: 2,
        max_trip_days: 4,
        departure_weekdays: [],
        return_weekdays: [],
      },
      progress: {
        total_pairs: 3,
        completed_pairs: 2,
        failed_pairs: 1,
        google_ok: 1,
        naver_ok: 1,
      },
    });
    expect(serialized.results.map((row) => row.best.price)).toEqual([200_000, 300_000]);
    expect(serialized.results[0]).toMatchObject({
      departure_date: "2026-10-02",
      return_date: "2026-10-03",
      trip_days: 2,
      best: { source: "naver", scraped_at: "2026-07-14T00:00:30.000Z" },
    });
    expect(serialized.errors).toEqual([{
      departure_date: "2026-10-03",
      return_date: "2026-10-04",
      source: "google",
      message: "timeout",
      at: "2026-07-14T00:00:40.000Z",
    }]);
    expect(job.results.map((row) => row.best.price)).toEqual([300_000, 200_000]);
  });

  it("breaks equal-price ties by departure then return date", () => {
    const job = makeJob();
    job.results = job.results.map((row) => ({
      ...row,
      best: { ...row.best, price: 250_000 },
    })).reverse();

    expect(serializeSearchJob(job).results.map((row) => [
      row.departure_date,
      row.return_date,
    ])).toEqual([
      ["2026-10-01", "2026-10-02"],
      ["2026-10-02", "2026-10-03"],
    ]);
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/mcp/serialization.test.ts`

Expected: FAIL because `serializeSearchJob` is missing.

- [ ] **Step 3: Implement explicit serialization**

Create `src/mcp/serialization.ts`:

```ts
import type {
  BestQuote,
  JobError,
  SearchJob,
  SearchResultRow,
} from "../jobs/types.js";
import type { Quote } from "../providers/types.js";

const serializeQuote = (quote: Quote) => ({
  price: quote.price,
  currency: quote.currency,
  url: quote.url,
  ...(quote.airline === undefined ? {} : { airline: quote.airline }),
  scraped_at: quote.scrapedAt,
});

const serializeBest = (quote: BestQuote) => ({
  source: quote.source,
  ...serializeQuote(quote),
});

const serializeResult = (row: SearchResultRow) => ({
  departure_date: row.departureDate,
  return_date: row.returnDate,
  trip_days: row.tripDays,
  google: row.google === null ? null : serializeQuote(row.google),
  naver: row.naver === null ? null : serializeQuote(row.naver),
  best: serializeBest(row.best),
});

const serializeError = (error: JobError) => ({
  departure_date: error.departureDate,
  return_date: error.returnDate,
  source: error.source,
  message: error.message,
  at: error.at,
});

export const serializeSearchJob = (job: SearchJob) => ({
  job_id: job.jobId,
  status: job.status,
  created_at: job.createdAt,
  updated_at: job.updatedAt,
  request: {
    origin: job.request.origin,
    destination: job.request.destination,
    months: [...job.request.months],
    min_trip_days: job.request.minTripDays,
    max_trip_days: job.request.maxTripDays,
    departure_weekdays: [...job.request.departureWeekdays],
    return_weekdays: [...job.request.returnWeekdays],
  },
  progress: {
    total_pairs: job.progress.totalPairs,
    completed_pairs: job.progress.completedPairs,
    failed_pairs: job.progress.failedPairs,
    google_ok: job.progress.googleOk,
    naver_ok: job.progress.naverOk,
  },
  results: [...job.results]
    .sort(
      (left, right) =>
        left.best.price - right.best.price ||
        left.departureDate.localeCompare(right.departureDate) ||
        left.returnDate.localeCompare(right.returnDate),
    )
    .map(serializeResult),
  errors: job.errors.map(serializeError),
});

export type SerializedSearchJob = ReturnType<typeof serializeSearchJob>;
```

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/mcp/serialization.test.ts && npm run typecheck`

Expected: all serialization tests pass; no TypeScript diagnostics.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/serialization.ts tests/mcp/serialization.test.ts
git commit -m "feat: serialize MCP job snapshots"
```

## Task 3: Implement Transport-Independent Tool Handlers

**Files:**
- Create: `tests/mcp/tools.test.ts`
- Create: `src/mcp/tools.ts`

- [ ] **Step 1: Build an offline fake core in the test**

The fake implements the Phase 1-shaped `McpCore`: `enumerateDatePairs`, `start`, `getStatus`, `cancel`, `waitForIdle`, and `recoverInterrupted`. Every method is a `vi.fn`; no provider, store, timer, or background scheduler is instantiated.

```ts
import { vi } from "vitest";
import type { DatePair, FlexibleSearchRequest } from "../../src/domain/types.js";
import type { McpCore } from "../../src/mcp/tools.js";

const normalizedRequest: FlexibleSearchRequest = {
  origin: "ICN",
  destination: "NRT",
  months: ["2026-10"],
  minTripDays: 2,
  maxTripDays: 3,
  departureWeekdays: [],
  returnWeekdays: [],
};
const pairA: DatePair = {
  departureDate: "2026-10-01",
  returnDate: "2026-10-02",
  tripDays: 2,
};
const pairB: DatePair = {
  departureDate: "2026-10-02",
  returnDate: "2026-10-04",
  tripDays: 3,
};
const fake = {
  enumerateDatePairs: vi.fn<McpCore["enumerateDatePairs"]>(),
  start: vi.fn<McpCore["start"]>(),
  getStatus: vi.fn<McpCore["getStatus"]>(),
  cancel: vi.fn<McpCore["cancel"]>(),
  waitForIdle: vi.fn<McpCore["waitForIdle"]>(),
  recoverInterrupted: vi.fn<McpCore["recoverInterrupted"]>(),
} satisfies McpCore;
```

Use this test matrix:

```ts
it("rejects invalid input before enumerate/start");
it("rejects zero pairs before start");
it("returns the queued StartSearchResult without waiting for idle");
it("calls orchestrator start exactly once");
it("maps start rejection to INTERNAL_ERROR without retry");
it("rejects a start result whose totalPairs differs from the precheck");
it("returns idempotent partial status sorted and serialized");
it("maps an unknown status job id to JOB_NOT_FOUND");
it("delegates cooperative cancellation and preserves partial results");
it.each(["cancelled", "completed", "failed"])(
  "keeps terminal %s cancellation idempotent",
);
it("maps an unknown cancel job id to JOB_NOT_FOUND");
```

For reject-before-start:

```ts
fake.enumerateDatePairs.mockReturnValue([]);

const result = await tools.start(validInput);

expect(result).toEqual({
  ok: false,
  error: {
    code: "EMPTY_DATE_PAIRS",
    message: "No date pairs match the search conditions",
  },
});
expect(fake.start).not.toHaveBeenCalled();
```

For immediate queued return, make `waitForIdle` a promise that never settles. The MCP handler must still resolve because it only awaits Phase 1 `start`:

```ts
fake.enumerateDatePairs.mockReturnValue([pairA, pairB]);
fake.start.mockResolvedValue({
  jobId: "job-1",
  totalPairs: 2,
  status: "queued",
});
fake.waitForIdle.mockReturnValue(new Promise<void>(() => undefined));

const result = await tools.start(validInput);

expect(result).toEqual({
  ok: true,
  value: { job_id: "job-1", total_pairs: 2, status: "queued" },
});
expect(fake.start).toHaveBeenCalledTimes(1);
expect(fake.start).toHaveBeenCalledWith(normalizedRequest);
expect(fake.waitForIdle).not.toHaveBeenCalled();
```

For start rejection:

```ts
fake.enumerateDatePairs.mockReturnValue([pairA]);
fake.start.mockRejectedValue(new Error("store unavailable"));

await expect(tools.start(validInput)).resolves.toEqual({
  ok: false,
  error: {
    code: "INTERNAL_ERROR",
    message: "Unable to start search",
  },
});
expect(fake.start).toHaveBeenCalledTimes(1);
expect(fake.cancel).not.toHaveBeenCalled();
expect(fake.waitForIdle).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/mcp/tools.test.ts`

Expected: FAIL because `createMcpTools` does not exist.

- [ ] **Step 3: Implement direct Phase 1 delegation**

`src/mcp/tools.ts` must:

1. export the `McpCore`, `ToolResult`, and `createMcpTools(core)` contracts;
2. use `safeParse` and map all Zod failures to `INVALID_INPUT` with deterministic issue text;
3. call `core.enumerateDatePairs(request)` and return `EMPTY_DATE_PAIRS` before `core.start` when length is zero;
4. call `core.start(request)` exactly once and await only its `StartSearchResult`;
5. return its `jobId`, `totalPairs`, and queued status in snake_case without calling `waitForIdle`;
6. validate `status === "queued"` and `totalPairs === precheckedPairs.length`; mismatch maps to `INTERNAL_ERROR` and never triggers a second start;
7. map a rejected `core.start` to deterministic `INTERNAL_ERROR` without retry, cancellation, or direct store mutation;
8. implement status as read-only `core.getStatus` plus `serializeSearchJob`;
9. implement cancel through `core.cancel` only; do not mutate returned snapshots in MCP code;
10. map imported Phase 1 `JobNotFoundError` to `JOB_NOT_FOUND`, and map all other core errors to `INTERNAL_ERROR` without stack traces;
11. never add a second lifecycle scheduler or call private store operations.

The returned API is:

```ts
export interface McpTools {
  start(input: unknown): Promise<ToolResult>;
  getStatus(input: unknown): Promise<ToolResult>;
  cancel(input: unknown): Promise<ToolResult>;
}
```

For successful cancel, return only:

```ts
{
  ok: true,
  value: { job_id: job.jobId, status: job.status },
}
```

The Phase 1 orchestrator owns lifecycle behavior: `start` stores queued and schedules its run, top-level run rejection is observed and persisted there, `cancel` sets the cooperative token, and `waitForIdle` supports tests/shutdown. MCP tests prove one-call delegation and response mapping; Phase 1 tests prove background safety and queue-level cooperation.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/mcp/tools.test.ts && npm run typecheck`

Expected: all handler tests pass; start is called once, zero pairs call it zero times, `waitForIdle` is never called by the start handler, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/tools.test.ts
git commit -m "feat: add MCP search tool handlers"
```

## Task 4: Bind the Verified MCP SDK API

**Files:**
- Create: `tests/mcp/server.test.ts`
- Create: `src/mcp/server.ts`

- [ ] **Step 1: Write the in-process smoke using verified SDK names**

Using only the exact exports and signatures confirmed in Task 0, create a server/client pair entirely in-process. The test must:

1. inject offline `McpCore` fake dependencies;
2. connect the verified SDK client and server through the verified in-memory/low-level paired transport;
3. call tools/list and assert exactly these names:

```ts
expect(toolNames.sort()).toEqual([
  "cancel_search",
  "get_search_status",
  "start_flexible_search",
]);
```

4. call `start_flexible_search` with lowercase IATA and duplicate months/weekdays;
5. parse the returned text JSON and assert queued response;
6. poll `get_search_status` and assert snake_case partial response;
7. call cancel twice and assert both responses are cancelled;
8. close client, transport, and server in `afterEach`.

This step intentionally does not prescribe unverified SDK constructors or registration calls. The test code must be concrete against the installed `.d.ts`; no `as any`, dynamic property probing, or guessed API compatibility shim is allowed.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/mcp/server.test.ts`

Expected: FAIL because the MCP server factory and tool registration do not exist.

- [ ] **Step 3: Implement `server.ts` against the installed declarations**

Implement and export:

```ts
export interface ServerOptions {
  core: McpCore;
}

export async function runStdioServer(): Promise<void>;
```

`createMcpServer(options)`도 export하고, 반환 타입은 Task 0에서 확인한 설치 SDK server class의 정확한 타입으로 명시한다. 확인 전 임시 타입, `any`, 주석형 타입 자리는 쓰지 않는다.

Requirements:

- tool descriptions state that start is asynchronous, status may be partial, and cancel is cooperative;
- registration input schemas are derived from the Zod schemas in `validation.ts`, or represented with the exact installed SDK-supported schema form while handlers still parse with those Zod schemas;
- all three registrations call `createMcpTools(options.core)`;
- successful `ToolResult` becomes one JSON text content;
- failed `ToolResult` becomes the installed SDK's supported tool-error response with the JSON error payload as text;
- only `runStdioServer()` creates/opens stdio transport;
- module import has no side effects, allowing in-process tests;
- direct execution detection uses ESM-safe `import.meta.url` comparison and invokes `runStdioServer()`;
- fatal startup errors are written to stderr and set `process.exitCode = 1`;
- stdout receives no diagnostics;
- production wiring imports `generateDatePairs`, `JsonJobStore`, `createSearchOrchestrator`, `GoogleFlightProvider`, `NaverFlightProvider`, and the actual selected-mode client exports confirmed in Task 0;
- production creates each real client using its verified constructor, passes it to `new GoogleFlightProvider(client)` / `new NaverFlightProvider(client)`, then creates exactly one orchestrator:

```ts
const orchestrator = createSearchOrchestrator({
  google,
  naver,
  store,
  generateDatePairs,
  createJobId: ulid,
});
const core: McpCore = {
  enumerateDatePairs: generateDatePairs,
  start: (request) => orchestrator.start(request),
  getStatus: (jobId) => orchestrator.getStatus(jobId),
  cancel: (jobId) => orchestrator.cancel(jobId),
  waitForIdle: (jobId) => orchestrator.waitForIdle(jobId),
  recoverInterrupted: () => orchestrator.recoverInterrupted(),
};
```

- startup calls `core.recoverInterrupted()` once before accepting stdio requests;
- if real client construction needs config, use only the verified Phase 2 constructor arguments and existing environment conventions. Missing public construction APIs are `BLOCKED`, not a reason to recreate provider/client behavior in `server.ts`.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/mcp/server.test.ts && npm run typecheck`

Expected: tools/list contains exactly three tools; in-process start/status/cancel smoke passes offline; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "feat: expose flight search over MCP"
```

## Task 5: Smoke-Test the Built stdio Server

**Files:**
- Create: `tests/mcp/stdio-smoke.test.ts`

- [ ] **Step 1: Write a child-process stdio test with the verified SDK client**

Use the exact `StdioClientTransport`/client constructor options confirmed in Task 0. Configure it to launch:

```ts
{
  command: process.execPath,
  args: ["dist/mcp/server.js"],
  env: {
    ...process.env,
    SEARCH_WAY_OFFLINE_SMOKE: "1",
    SEARCH_WAY_DATA_DIR: directory,
  },
}
```

Before launching, the test creates `const directory = await mkdtemp(join(tmpdir(), "search-way-mcp-"))`, passes it as `SEARCH_WAY_DATA_DIR`, and removes it recursively in `finally`. The production server interprets `SEARCH_WAY_OFFLINE_SMOKE=1` only as a composition switch: it supplies two deterministic `FlightProvider` fakes to the real `createSearchOrchestrator`, along with `new JsonJobStore(SEARCH_WAY_DATA_DIR)`, real `generateDatePairs`, installed `ulid` as `createJobId`, and zero-delay config. It must not contact Google/Naver or persist outside that temp directory.

The smoke test calls tools/list and asserts the exact three names. Then it closes the client/transport and asserts the child exits without hanging. Set a 10-second Vitest timeout and always close/kill the child in `finally` so failures do not leak processes.

Do not hand-code JSON-RPC framing or hard-code a protocol version; the installed SDK client is the source of truth for initialization and request framing.

- [ ] **Step 2: Run RED against a fresh build**

Run:

```bash
npm run build
npm test -- tests/mcp/stdio-smoke.test.ts
```

Expected: the first smoke attempt fails until offline composition and lifecycle shutdown are correctly wired; it must not make a live network request.

- [ ] **Step 3: Complete offline stdio composition**

Add the minimum `server.ts` composition required by the test:

- define two small `FlightProvider` objects with IDs `google`/`naver`; each `findDirectRoundTrip` returns fixed `KRW`, deterministic price, `https://example.test/` URL, and fixed ISO `scrapedAt`;
- construct `JsonJobStore` with the required `SEARCH_WAY_DATA_DIR`; in offline mode, missing `SEARCH_WAY_DATA_DIR` is a startup error rather than silently writing elsewhere;
- call the real `createSearchOrchestrator({ google: fakeGoogle, naver: fakeNaver, store, generateDatePairs, createJobId: ulid, config: { minDelayMs: 0, maxDelayMs: 0 } })`;
- adapt that returned `SearchOrchestrator` to `McpCore` using the same direct wrapper as production;
- call `recoverInterrupted()` before connecting stdio;
- allow transport close to exit, and remove the temp directory in the test `finally`;
- select no fake path unless `SEARCH_WAY_OFFLINE_SMOKE === "1"`.

Do not duplicate queued job creation, job maps, run scheduling, cancellation state, or status persistence in `server.ts`; all lifecycle behavior must execute through the real Phase 1 orchestrator.

- [ ] **Step 4: Run GREEN from clean build output**

Run:

```bash
npm run build
npm test -- tests/mcp/stdio-smoke.test.ts
npm test -- tests/mcp
```

Expected: build exits 0; built child lists exactly the three tools; all MCP tests pass offline; no process hangs and no live provider hostname appears in output.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/stdio-smoke.test.ts
git commit -m "test: smoke test built MCP stdio server"
```

## Task 6: Phase Verification and Contract Audit

**Files:**
- Verify only: all Ownership paths

- [ ] **Step 1: Run focused and full verification**

Run:

```bash
npm run typecheck
npm test -- tests/mcp
npm test
npm run build
npm test -- tests/mcp/stdio-smoke.test.ts
```

Expected: every command exits 0; all tests use mock providers/fixtures; the built stdio smoke lists exactly the three required tools.

- [ ] **Step 2: Prove reject-before-start and single delegation**

Run:

```bash
npm test -- tests/mcp/validation.test.ts tests/mcp/tools.test.ts --reporter=verbose
```

Expected output includes passing cases for invalid IATA/month/trip/weekday/unknown key, zero pairs before start, immediate queued response without waiting for idle, exactly one start delegation, start rejection mapping, unknown job ID, idempotent status, and terminal/repeated cancel behavior.

- [ ] **Step 3: Audit forbidden writes and placeholders**

Run:

```bash
git status --short
git diff --name-only
rg -n "TBD|TODO|implement later|fill in|as any|@ts-ignore|@ts-expect-error" src/mcp tests/mcp
```

Expected: changed implementation paths are only Ownership files; the placeholder/escape-hatch scan returns no matches. Existing unrelated user changes, if any, remain untouched and are explicitly excluded from commits.

- [ ] **Step 4: Audit contract fields**

Run:

```bash
rg -n "start_flexible_search|get_search_status|cancel_search|job_id|total_pairs|trip_days|departure_weekdays|return_weekdays|scraped_at|completed_pairs|failed_pairs|google_ok|naver_ok" src/mcp tests/mcp
```

Expected: every external field is snake_case; internal shared types remain camelCase; serialization is centralized in `serialization.ts`.

- [ ] **Step 5: Final commit only if verification caused a legitimate MCP-owned change**

```bash
git add src/mcp tests/mcp
git commit -m "test: verify MCP lifecycle contracts"
```

Expected: create this commit only when Task 6 required an actual fix or additional assertion. Do not create an empty commit and do not amend earlier commits.

## Verification

Run from repository root:

```bash
npm run typecheck
npm test -- tests/mcp
npm test
npm run build
npm test -- tests/mcp/stdio-smoke.test.ts
```

Expected:

- all commands exit 0;
- `start_flexible_search`, `get_search_status`, `cancel_search` are the exact tools/list names;
- invalid input and zero pairs create no job;
- start returns queued before background completion;
- MCP schedules no duplicate background execution; Phase 1 owns background rejection handling;
- status returns sorted snake_case partial/final snapshots and unknown IDs map to `JOB_NOT_FOUND`;
- cancel is idempotent and delegates cooperative cancellation while preserving partial data;
- in-process and built stdio smoke use offline mock providers only;
- stdout remains valid MCP protocol output.

## Output

The implementing agent must report:

- changed files, limited to Ownership;
- installed MCP SDK and Zod versions verified in Task 0;
- the exact SDK imports/registration/transport/client APIs confirmed from installed declarations;
- the actual Google/Naver selected-mode client export names and constructor arguments used to construct `GoogleFlightProvider`/`NaverFlightProvider`;
- focused MCP test, full offline test, typecheck, build, and built stdio smoke results;
- tool list evidence;
- confirmation that no live provider request occurred;
- any contract mismatch with Phase 1/2 exports;
- `BLOCKED` if a required core capability or installed package is missing rather than modifying Forbidden Writes.

## Self-Review Checklist

- [x] Header matches the writing-plans format and every execution step is a checkbox.
- [x] Ownership, Forbidden Writes, Dependencies, Contract, Verification, and Output are present.
- [x] All four `src/mcp` paths and all `tests/mcp/*` paths are exact.
- [x] `McpCore` matches Phase 1 `SearchOrchestrator.start/getStatus/cancel/waitForIdle/recoverInterrupted` plus Phase 0 pair enumeration.
- [x] IATA uppercase normalization, months unique/sorted/valid/max 3, trip bounds, weekday dedupe/range, and zero-pair pre-job rejection are covered by code/tests.
- [x] start returns queued without waiting for idle, delegates exactly once, and maps direct start rejection to `INTERNAL_ERROR`.
- [x] MCP contains no duplicate lifecycle scheduling or private job-store lifecycle reconstruction.
- [x] status is non-mutating/idempotent, supports partial sorted results, maps errors, and handles unknown IDs.
- [x] cancel repeat/terminal behavior and cooperative ownership are explicit.
- [x] SDK version/API discovery commands precede any SDK-specific implementation and no guessed SDK API is asserted.
- [x] actual Zod and serialization implementations plus concrete test assertions are included.
- [x] production wiring checks actual provider/client constructors before composing one real `createSearchOrchestrator`.
- [x] in-process and built stdio smoke are offline, and stdio uses fake providers with real `JsonJobStore`, `generateDatePairs`, and `createSearchOrchestrator`.
- [x] commands, expected outcomes, and commit boundaries contain no placeholders.
