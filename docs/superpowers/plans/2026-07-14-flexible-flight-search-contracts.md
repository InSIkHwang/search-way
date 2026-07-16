# Flexible Flight Search Shared Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 Phase가 공유할 TypeScript 프로젝트 기반과 공개 타입 계약을 먼저 고정한다.

**Architecture:** 단일 Node.js ESM 패키지에서 도메인 입력·날짜쌍, provider, job 상태 타입을 각각 작은 파일로 분리한다. 이후 Phase는 이 파일을 수정하지 않고 import하여 구현하며, 계약 변경은 통합 담당자만 수행한다.

**Tech Stack:** Node.js 20+, TypeScript, npm, Vitest, Zod, ULID, MCP TypeScript SDK

---

## Ownership

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vitest.config.ts`
- `tests/setup/network-guard.ts`
- `.gitignore`
- `.env.example`
- `src/domain/types.ts`
- `src/providers/types.ts`
- `src/jobs/types.ts`

## Forbidden Writes

- `src/domain/date-combinator.ts`
- `src/orchestrator/**`
- `src/jobs/store.ts`
- `src/providers/google/**`
- `src/providers/naver/**`
- `src/mcp/**`
- `tests/**`
- `scripts/**`

## Dependencies

- 설계 기준: `docs/superpowers/specs/2026-07-14-flexible-flight-search-design.md`
- Node.js 20 이상과 npm이 로컬에 설치되어 있어야 한다.

## Contract

### 모듈 경계

- `src/domain/types.ts`: 정규화된 검색 요청과 날짜쌍
- `src/providers/types.ts`: provider 식별자, quote, provider 인터페이스
- `src/jobs/types.ts`: 결과 행, 진행률, 오류, 영속 job 스냅샷
- 날짜는 모두 `YYYY-MM-DD`, 월은 `YYYY-MM`, 시각은 ISO-8601 UTC 문자열이다.
- `tripDays`만 내부 camelCase를 쓰고 MCP 경계에서 `trip_days`로 변환한다.
- `best` 동점은 Google 우선이며, 서로 다른 통화는 비교하지 않는다.

### 공개 타입

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
import type { DatePair } from "../domain/types.js";

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
import type { DatePair, FlexibleSearchRequest } from "../domain/types.js";
import type { ProviderId, Quote } from "../providers/types.js";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface BestQuote extends Quote {
  source: ProviderId;
}

export interface SearchResultRow extends DatePair {
  google: Quote | null;
  naver: Quote | null;
  best: BestQuote;
}

export interface SearchProgress {
  totalPairs: number;
  completedPairs: number;
  failedPairs: number;
  googleOk: number;
  naverOk: number;
}

export type JobErrorCode =
  | "provider_timeout"
  | "provider_blocked"
  | "no_direct_flight"
  | "currency_mismatch"
  | "provider_error";

export interface JobError {
  departureDate: string;
  returnDate: string;
  source: ProviderId;
  code: JobErrorCode;
  message: string;
  at: string;
}

export interface SearchJob {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  request: FlexibleSearchRequest;
  progress: SearchProgress;
  results: SearchResultRow[];
  errors: JobError[];
  cancellationRequested: boolean;
  failureReason?: "interrupted" | "store_error" | "startup_error";
}
```

## Task 1: Bootstrap the TypeScript package

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tests/setup/network-guard.ts`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 0: Confirm the Git execution policy**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected: `true`. If this directory is not a Git worktree, stop before all commit steps and ask the user to choose either repository initialization or an explicitly commit-free execution. Do not silently run `git init`.

- [ ] **Step 1: Initialize npm and install runtime dependencies**

Run:

```bash
npm init -y
npm install @modelcontextprotocol/sdk ulid zod
npm install --save-dev @types/node tsx typescript vitest
npm pkg set type=module
npm pkg set engines.node=">=20"
npm pkg set scripts.build="tsc -p tsconfig.json"
npm pkg set scripts.typecheck="tsc -p tsconfig.json --noEmit"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.test:watch="vitest"
npm pkg set scripts.test:unit="vitest run tests/domain tests/orchestrator tests/jobs"
npm pkg set scripts.test:providers="vitest run tests/providers"
npm pkg set scripts.test:mcp="vitest run tests/mcp"
npm pkg set scripts.spike:google="tsx scripts/spike-google.ts"
npm pkg set scripts.spike:naver="tsx scripts/spike-naver.ts"
npm pkg set scripts.start:mcp="node dist/mcp/server.js"
npm pkg set scripts.dev:mcp="tsx src/mcp/server.ts"
```

Expected: `package.json`과 `package-lock.json`이 생성되고 설치 명령이 모두 exit code 0으로 끝난다.

- [ ] **Step 2: Add strict NodeNext TypeScript configuration**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup/network-guard.ts"],
    restoreMocks: true,
  },
});
```

- [ ] **Step 3: Block accidental live fetches in the default test process**

Create `tests/setup/network-guard.ts`:

```ts
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
```

Provider HTTP contract tests may replace this stub with their own `vi.stubGlobal("fetch", fakeFetch)`. Browser-mode contract tests must inject a fake browser/page factory; default automated tests must never instantiate a real Playwright browser.

- [ ] **Step 4: Ignore generated data and secrets**

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.env
data/jobs/*.json
playwright-report/
test-results/
```

Create `.env.example`:

```dotenv
SEARCH_WAY_DATA_DIR=./data/jobs
SEARCH_WAY_PROVIDER_CONCURRENCY=2
SEARCH_WAY_MIN_DELAY_MS=500
SEARCH_WAY_MAX_DELAY_MS=1500
```

- [ ] **Step 5: Verify the empty project**

Run: `npm run typecheck && npm test && npm run build`

Expected: typecheck와 build는 exit code 0이고, Vitest는 테스트 파일이 아직 없다는 이유로 실패할 수 있다. 이 시점에는 `npm test -- --passWithNoTests`가 exit code 0이어야 한다.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts tests/setup/network-guard.ts .gitignore .env.example
git commit -m "chore: bootstrap TypeScript flight search package"
```

## Task 2: Define domain and provider contracts

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/providers/types.ts`

- [ ] **Step 1: Create the domain types**

Create `src/domain/types.ts` with the exact `FlexibleSearchRequest` and `DatePair` definitions in the Public Types section.

- [ ] **Step 2: Create the provider types**

Create `src/providers/types.ts` with the exact `ProviderId`, `Quote`, `ProviderSearchInput`, and `FlightProvider` definitions in the Public Types section.

- [ ] **Step 3: Verify imports and strict types**

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 4: Commit**

```bash
git add src/domain/types.ts src/providers/types.ts
git commit -m "feat: define search and provider contracts"
```

## Task 3: Define persisted job contracts

**Files:**
- Create: `src/jobs/types.ts`

- [ ] **Step 1: Create the job types**

Create `src/jobs/types.ts` with the exact job definitions in the Public Types section.

- [ ] **Step 2: Verify the complete contract layer**

Run: `npm run typecheck && npm run build`

Expected: both commands exit 0 and `dist/domain/types.d.ts`, `dist/providers/types.d.ts`, `dist/jobs/types.d.ts` exist.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/types.ts
git commit -m "feat: define persistent search job contracts"
```

## Task 4: Reconcile the Phase 0 acquisition dependency

**Files:**
- Read: `docs/spikes/2026-07-14-google-findings.md`
- Read: `docs/spikes/2026-07-14-naver-findings.md`
- Modify conditionally: `package.json`
- Modify conditionally: `package-lock.json`

Run this task only after Phase 0 passes and before Phase 2 starts.

- [ ] **Step 1: Read both selected acquisition modes**

Run:

```bash
rg -n "selected.mode|acquisition.mode|mode.*(http|playwright)" docs/spikes/2026-07-14-google-findings.md docs/spikes/2026-07-14-naver-findings.md
```

Expected: each findings document identifies exactly one selected mode, `http` or `playwright`. Missing or conflicting evidence is `BLOCKED`; do not infer a dependency.

- [ ] **Step 2: Install Playwright only when selected**

If both sources selected HTTP, make no package change and record `Playwright not required`.

If either source selected Playwright, run:

```bash
npm install playwright
npx playwright install chromium
npm ls playwright --depth=0
```

Expected: `package.json` and `package-lock.json` contain Playwright, Chromium installation exits 0, and `npm ls` reports one installed version. Do not install Playwright when neither adapter uses it.

- [ ] **Step 3: Verify the reconciled package**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: all commands exit 0 and default tests make no live request.

- [ ] **Step 4: Commit only when package files changed**

```bash
git add package.json package-lock.json
git commit -m "chore: add verified browser provider runtime"
```

If both sources use HTTP, do not create an empty commit.

## Verification

Run:

```bash
npm run typecheck
npm run build
npm test -- --passWithNoTests
```

Expected: all commands exit 0; no live network request occurs.

## Output

Implementing agent must report:

- changed files;
- installed runtime and development dependencies;
- typecheck/build/test results;
- any contract mismatch with the design spec;
- `BLOCKED` if Node.js 20+ or npm is unavailable.
