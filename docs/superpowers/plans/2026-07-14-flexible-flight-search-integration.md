# Flexible Flight Search Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 0~4 산출물이 동일 계약을 지키는지 확인하고, 실제 date combinator→orchestrator→job store 흐름과 MCP stdio 경계를 offline으로 검증한 뒤 수동 live acceptance를 수행한다.

**Architecture:** 통합 단계는 subsystem 동작을 다시 구현하지 않는다. 공통 공개 API로 cross-layer test를 추가하고, write-set·계약·fixture provenance를 감사한 뒤 전체 offline suite와 빌드 산출물을 검증한다. live provider 검증은 CI 밖에서 한 개의 작은 job으로만 수행한다.

**Tech Stack:** Node.js 20+, TypeScript, Vitest, MCP TypeScript SDK, Phase 0 sanitized findings/fixtures

---

## Ownership

- `tests/integration/search-flow.test.ts`
- `README.md`
- `package.json`, `package-lock.json`은 contracts Task 4가 누락된 경우에만 수정
- `src/mcp/server.ts`는 production composition 연결 오류가 통합 test로 입증된 경우에만 수정

## Forbidden Writes

- `src/domain/**`
- `src/jobs/types.ts`
- `src/providers/types.ts`
- `src/orchestrator/config.ts`
- `src/orchestrator/merge-results.ts`
- `src/orchestrator/queue.ts`
- `src/jobs/store.ts`
- `src/providers/google/parser.ts`
- `src/providers/naver/parser.ts`
- 기존 unit/contract test의 기대값 완화
- Phase 0 findings와 sanitized fixture의 근거 없는 수정

통합 실패가 Forbidden Writes의 결함이면 임의 수정하지 않는다. 소유 Phase, 재현 명령, 기대값, 실제값을 적어 `BLOCKED`로 반환하고 해당 Phase 계획으로 되돌린다.

## Dependencies

- Phase 0: G1, G2, G3 PASS
- contracts Task 4: selected acquisition dependency reconciled
- Phase 1: G4 PASS
- Phase 2: 두 provider offline contract PASS
- Phase 3: in-process 및 built stdio smoke PASS
- Phase 4: hardening gate PASS
- 각 구현 agent의 changed-file, verification, contract mismatch 보고서

## Contract

- `generateDatePairs(request)`가 유일한 date-pair 생성 규칙이다.
- `createSearchOrchestrator`는 Google/Naver `FlightProvider`, `JsonJobStore`, combinator, ID factory, config를 주입받는다.
- `start`는 queued 응답을 반환하고 `waitForIdle`은 해당 run의 종료 또는 store failure를 관찰한다.
- 정상 non-cancelled pair는 Google/Naver가 모두 호출된다.
- `getStatus` 결과는 persisted `SearchJob`이며 `results`는 price 오름차순이다.
- MCP 외부 필드는 snake_case이고 세 tool 이름은 설계와 정확히 같다.
- default test와 CI는 live network를 사용하지 않는다.

## Task 1: Audit phase reports and write sets

**Files:**
- Create/Modify: none

- [ ] **Step 0: Confirm Git is available for audit and commit steps**

Run: `git rev-parse --is-inside-work-tree`

Expected: `true`. Otherwise return `BLOCKED: Git execution policy unresolved` and apply the user decision required by the contracts plan before continuing.

- [ ] **Step 1: Check every required artifact**

Run:

```bash
test -f src/domain/date-combinator.ts
test -f src/orchestrator/index.ts
test -f src/jobs/store.ts
test -f src/providers/google/provider.ts
test -f src/providers/naver/provider.ts
test -f src/mcp/server.ts
test -f docs/spikes/2026-07-14-google-findings.md
test -f docs/spikes/2026-07-14-naver-findings.md
```

Expected: every command exits 0. A missing artifact returns `BLOCKED` to its owning Phase.

- [ ] **Step 2: Confirm feasibility and selected modes**

Run:

```bash
rg -n "G1 PASS|3 consecutive|selected.mode|acquisition.mode" docs/spikes/2026-07-14-google-findings.md
rg -n "G2 PASS|3 consecutive|selected.mode|acquisition.mode" docs/spikes/2026-07-14-naver-findings.md
npm ls playwright --depth=0 || true
```

Expected: both findings prove three consecutive successes and exactly one selected mode. If either mode is Playwright, `npm ls` must report Playwright; if both are HTTP, its absence is valid.

- [ ] **Step 3: Check tracked secret and raw-capture safety**

Run:

```bash
git ls-files | rg '(^|/)(\.env|.*\.har|cookies?\.json|auth.*\.json)$' && exit 1 || true
git status --short
```

Expected: no secret/raw capture filename is tracked. Existing unrelated working-tree changes are recorded and left untouched.

## Task 2: Add a cross-layer offline search-flow test

**Files:**
- Create: `tests/integration/search-flow.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/search-flow.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateDatePairs } from "../../src/domain/date-combinator.js";
import type { FlexibleSearchRequest } from "../../src/domain/types.js";
import { JsonJobStore } from "../../src/jobs/store.js";
import { createSearchOrchestrator } from "../../src/orchestrator/index.js";
import type {
  FlightProvider,
  ProviderId,
  ProviderSearchInput,
  Quote,
} from "../../src/providers/types.js";

class RecordingProvider implements FlightProvider {
  readonly calls: ProviderSearchInput[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly price: number,
  ) {}

  async findDirectRoundTrip(input: ProviderSearchInput): Promise<Quote> {
    this.calls.push(structuredClone(input));
    return {
      price: this.price,
      currency: "KRW",
      url: `https://${this.id}.example/${input.departureDate}`,
      scrapedAt: "2026-07-14T00:00:00.000Z",
    };
  }
}

describe("offline search flow", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "search-way-integration-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("enumerates, queries both sources, persists, and sorts all pairs", async () => {
    const request: FlexibleSearchRequest = {
      origin: "ICN",
      destination: "NRT",
      months: ["2026-10"],
      minTripDays: 5,
      maxTripDays: 5,
      departureWeekdays: [4],
      returnWeekdays: [1],
    };
    const google = new RecordingProvider("google", 100_000);
    const naver = new RecordingProvider("naver", 110_000);
    const orchestrator = createSearchOrchestrator({
      google,
      naver,
      store: new JsonJobStore(directory),
      generateDatePairs,
      createJobId: () => "integration-job",
      config: {
        minDelayMs: 0,
        maxDelayMs: 0,
        random: () => 0,
        sleep: async () => undefined,
        now: () => "2026-07-14T00:00:00.000Z",
      },
    });

    expect(await orchestrator.start(request)).toEqual({
      jobId: "integration-job",
      totalPairs: 5,
      status: "queued",
    });

    await orchestrator.waitForIdle("integration-job");
    const status = await orchestrator.getStatus("integration-job");

    expect(status.status).toBe("completed");
    expect(status.progress).toEqual({
      totalPairs: 5,
      completedPairs: 5,
      failedPairs: 0,
      googleOk: 5,
      naverOk: 5,
    });
    expect(google.calls).toHaveLength(5);
    expect(naver.calls).toHaveLength(5);
    expect(status.results).toHaveLength(5);
    expect(status.results.every((row) => row.best.source === "google")).toBe(true);
    expect(status.results.map((row) => row.best.price)).toEqual([
      100_000,
      100_000,
      100_000,
      100_000,
      100_000,
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED or immediate compatibility**

Run: `npm test -- tests/integration/search-flow.test.ts`

Expected: PASS when all Phase 1 public signatures match their plans. A compile/signature failure is a contract mismatch, not permission to duplicate adapters in the test.

- [ ] **Step 3: Resolve only integration wiring differences**

If production exports have equivalent names but different import paths, update only the test imports. If required behavior or signature is absent, return `BLOCKED` to Phase 1 with the exact compiler diagnostic.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -- tests/integration/search-flow.test.ts && npm run typecheck`

Expected: one integration test passes, both source call counts are 5, and typecheck exits 0.

```bash
git add tests/integration/search-flow.test.ts
git commit -m "test: verify offline flexible search flow"
```

## Task 3: Audit public contracts across layers

**Files:**
- Create/Modify: none

- [ ] **Step 1: Verify external MCP names and fields**

Run:

```bash
rg -n "start_flexible_search|get_search_status|cancel_search" src/mcp tests/mcp
rg -n "job_id|total_pairs|completed_pairs|failed_pairs|google_ok|naver_ok|departure_date|return_date|trip_days|scraped_at" src/mcp tests/mcp
```

Expected: exactly three tool registrations exist and external serialized fields are snake_case.

- [ ] **Step 2: Verify no duplicate shared contract**

Run:

```bash
rg -n "interface (FlexibleSearchRequest|DatePair|Quote|FlightProvider|SearchJob)|type JobStatus" src
```

Expected: canonical declarations live only in `src/domain/types.ts`, `src/providers/types.ts`, and `src/jobs/types.ts`; other files only import them.

- [ ] **Step 3: Verify source isolation and offline fixtures**

Run:

```bash
npm test -- tests/providers/google
npm test -- tests/providers/naver
npm test -- tests/orchestrator
npm test -- tests/jobs
```

Expected: all commands exit 0 without live network or browser navigation.

## Task 4: Run the complete offline release gate

**Files:**
- Modify only on proven integration defect: `src/mcp/server.ts`

- [ ] **Step 1: Install exactly from the lockfile**

Run: `npm ci`

Expected: exit code 0 with no lockfile change.

- [ ] **Step 2: Run static and test verification**

Run:

```bash
npm run typecheck
npm test
npm run build
npm test -- tests/mcp/stdio-smoke.test.ts
```

Expected: all commands exit 0; full test output contains no skipped gate test and no live provider hostname.

- [ ] **Step 3: Inspect generated server and tool list**

Run:

```bash
test -f dist/mcp/server.js
npm test -- tests/mcp/server.test.ts tests/mcp/stdio-smoke.test.ts --reporter=verbose
```

Expected: built entry exists and verbose output proves the exact three tools are listed.

- [ ] **Step 4: Check repository cleanliness**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace error, generated `dist/` and job JSON are ignored, and all intended changes are accounted for.

## Task 5: Perform one bounded manual live acceptance

**Files:**
- Modify: `README.md` only to record the final verified invocation/limitations

- [ ] **Step 1: Reconfirm provider health**

Run each Phase 0 spike once with the committed sanitized profile and the same fixed case.

Expected: both return a positive KRW direct quote and official URL. This is a manual local check and is not added to `npm test`.

- [ ] **Step 2: Start one small real MCP job**

Using the Phase 3 verified MCP client or the configured Cursor MCP connection, call:

```json
{
  "origin": "ICN",
  "destination": "NRT",
  "months": ["2026-10"],
  "min_trip_days": 4,
  "max_trip_days": 4,
  "departure_weekdays": [6],
  "return_weekdays": [2]
}
```

Expected: `start_flexible_search` returns `queued` and a ULID without waiting for all provider calls.

- [ ] **Step 3: Poll and verify the final snapshot**

Poll `get_search_status` with the returned job ID until terminal.

Expected:

- status reaches `completed` unless an explicit system/store error is reported;
- completed jobs have `completed_pairs === total_pairs`; cancelled jobs derive unstarted pairs as `total_pairs - completed_pairs` without inventing an external field;
- both `google_ok` and `naver_ok` reflect attempted sources;
- successful rows contain both dates, trip days, source quotes, best, KRW, and URLs;
- results are price ascending;
- cell failures appear alongside successful partial results;
- no credential or raw response appears in output.

- [ ] **Step 4: Verify cancellation separately only if needed**

Start the same bounded request, immediately call `cancel_search`, then poll once.

Expected: status is `cancelled`, already completed partial results remain, and no new queued cell starts after the cooperative flag is observed.

- [ ] **Step 5: Record operational facts**

Update README only when observed startup command, selected provider mode, or known limitation is absent. Do not commit live prices, cookies, request IDs, or raw responses.

```bash
git add README.md
git commit -m "docs: record MCP live acceptance guidance"
```

Do not create this commit when README already contains the verified facts.

## Verification

Final automated gate:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm test -- tests/mcp/stdio-smoke.test.ts
git diff --check
```

Expected: every command exits 0; all automated verification is offline.

Final manual gate:

```text
Google one-shot health: PASS
Naver one-shot health: PASS
MCP start immediate queued: PASS
MCP partial/final poll: PASS
Both sources attempted: PASS
Sorted KRW results with URLs: PASS
Cooperative cancel: PASS
```

## Output

Integration agent must report:

- changed files and owning Phase;
- overlap check result;
- contracts Task 4 selected-mode dependency result;
- cross-layer test counts and both provider call counts;
- full typecheck/test/build/stdio results;
- manual live acceptance result or `not run (manual gate)`;
- secret/raw-capture audit result;
- contract mismatch routed to its owning Phase;
- final `PASS`, `BLOCKED`, or `PHASE 0 FAIL — STOP`.
