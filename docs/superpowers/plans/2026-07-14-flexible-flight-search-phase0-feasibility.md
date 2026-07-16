# Flexible Flight Search Phase 0 Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google Flights와 Naver Flights에서 동일한 왕복 직항 검색을 각각 3회 연속 재현하고, 모든 유연 날짜쌍을 결정적으로 생성하는 date combinator를 TDD로 구현하여 G1 ∧ G2 ∧ G3 feasibility gate를 판정한다.

**Architecture:** 공통 계약과 프로젝트 bootstrap이 끝난 뒤 G1 Google spike, G2 Naver spike, G3 date combinator를 write set이 겹치지 않는 세 작업흐름으로 병렬 실행한다. 각 provider는 실제 브라우저 네트워크 캡처에서만 재현 정보를 얻고, sanitized profile 직후 관찰된 shape를 소비하는 완전한 CLI 코드와 offline/live 검증을 source-specific addendum에 작성한다. 해당 addendum가 외부 승인되어 `Status: Approved`가 되기 전에는 CLI 구현을 중지하며, 세 결과는 마지막 gate 검토에서만 합친다.

**Tech Stack:** Node.js 20+, TypeScript, npm, Vitest, browser DevTools network capture, built-in `fetch`, 조건부 로컬 Playwright

---

## Ownership

이 계획 전체가 생성하거나 수정할 수 있는 파일은 다음뿐이다.

- `src/domain/date-combinator.ts`
- `tests/domain/date-combinator.test.ts`
- `scripts/spike-google.ts`
- `scripts/spike-naver.ts`
- `docs/spikes/2026-07-14-google-findings.md`
- `docs/spikes/2026-07-14-naver-findings.md`
- `docs/spikes/fixtures/google-direct-round-trip.sanitized.json`
- `docs/spikes/fixtures/naver-direct-round-trip.sanitized.json`
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md`
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md`

브라우저의 원본 HAR, request body, response body, 실행 로그는 저장소 밖의 `${TEMP:-/tmp}/search-way-phase0/`에만 둔다.

## Forbidden Writes

- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`
- `.gitignore`, `.env`, `.env.example`
- `src/domain/types.ts`
- `src/providers/**`
- `src/orchestrator/**`
- `src/jobs/**`
- `src/mcp/**`
- 위 Ownership에 열거되지 않은 `tests/**`, `scripts/**`, `docs/**`. 두 source addendum 경로는 명시적 예외로 생성·승인 수정할 수 있다.
- 그 밖의 저장소 내 모든 파일

공유 의존성 파일 변경이 필요하다고 판단되면 변경하지 말고 `BLOCKED`로 보고한다. Playwright 분기는 `npm install --no-save --package-lock=false playwright`로 로컬 `node_modules`에만 설치하며 manifest나 lockfile을 바꾸지 않는다.

## Dependencies

- 설계 기준: `docs/superpowers/specs/2026-07-14-flexible-flight-search-design.md`
- 공유 계약: `docs/superpowers/plans/2026-07-14-flexible-flight-search-contracts.md`
- 실행 순서: `docs/superpowers/plans/2026-07-14-flexible-flight-search-master.md`
- contracts 계획이 완료되어 Node.js 20+, npm, TypeScript, Vitest, `tsx`, `src/domain/types.ts`가 존재해야 한다.
- G1/G2 실행자는 공식 Google Flights/Naver Flights UI를 브라우저에서 열고 DevTools Network의 HAR with content를 저장할 수 있어야 한다.
- G1/G2의 최초 제안 사례는 `ICN → NRT`, 출발 `2026-10-08`, 귀국 `2026-10-12`, 성인 1명, 이코노미, 왕복, 직항만이다. 해당 날짜에 실제 직항 결과가 없으면 같은 실행자가 공식 UI에서 직항이 표시되는 가장 가까운 미래 날짜쌍 하나를 선택한다. 캡처 직후 provider별 `final_case`를 profile과 findings에 구조적으로 확정하며, 3회 검증과 Phase 2 fixture/parser 검증은 최초 제안일을 하드코딩하지 않고 이 `final_case`를 소비한다.

## Contract

### G3 date combinator

```ts
import type { DatePair, FlexibleSearchRequest } from "./types.js";

export function generateDatePairs(
  request: FlexibleSearchRequest,
): DatePair[];
```

- `months`는 출발 가능 달이며 귀국일은 선택 달 밖이어도 허용한다.
- `tripDays`는 출발일과 귀국일을 모두 포함하므로 `return = departure + tripDays - 1일`이다.
- 빈 `departureWeekdays`와 `returnWeekdays`는 모든 요일을 뜻한다.
- 요일은 UTC 기준 `0=Sun ... 6=Sat`이다.
- 결과는 `(departureDate, returnDate)` 중복을 제거하고 출발일, 귀국일 순으로 오름차순 정렬한다.
- 이 함수는 네트워크, 시스템 시계, 로컬 timezone을 사용하지 않는다.

### G1/G2 spike CLI

두 CLI는 provider별 sanitized profile을 읽고 같은 출력 계약을 지킨다.

```ts
interface SpikeOutput {
  provider: "google" | "naver";
  attempt: 1 | 2 | 3;
  mode: "http" | "playwright";
  origin: string;
  destination: string;
  departureDate: string;
  returnDate: string;
  direct: true;
  price: number;
  currency: "KRW";
  url: string;
  observedAt: string;
}
```

실행 형식:

```bash
npm run spike:google -- --profile docs/spikes/fixtures/google-direct-round-trip.sanitized.json --attempt 1
npm run spike:naver -- --profile docs/spikes/fixtures/naver-direct-round-trip.sanitized.json --attempt 1
```

- 성공 시 stdout에는 마지막 줄에 `SpikeOutput` JSON 하나를 쓰고 exit code 0으로 끝낸다.
- HTTP 4xx/5xx, timeout, captcha/로그인 요구, 파싱 실패, 직항 증거 부재, `price <= 0`, KRW 이외 통화, 공식 출처가 아닌 URL이면 stderr에 원인을 쓰고 exit code 1로 끝낸다.
- 세 번의 가격은 변동될 수 있다. 3회 성공은 가격 동일성이 아니라 고정 검색 조건, 직항 증거, 양의 숫자 가격, KRW, 공식 URL이 매번 유효함을 뜻한다.
- CLI 코드에는 추측한 endpoint, response path, DOM selector를 넣지 않는다. 실제 캡처에서 확인한 값만 sanitized profile에 기록하고 CLI는 그 profile을 해석한다.

### Phase 2 canonical handoff

각 provider의 sanitized profile은 Phase 2가 직접 소비하는 canonical fixture이자 검색 사례의 단일 source of truth다. findings에는 `## Phase 2 Handoff` 아래에 profile과 바이트 단위로 같은 의미를 갖는 JSON object를 기록한다.

```ts
interface CanonicalSearchCase {
  origin: string;
  destination: string;
  departure_date: string;
  return_date: string;
  adults: 1;
  cabin: "economy";
  trip_type: "round_trip";
  nonstop: true;
}

type UrlRecipe =
  | {
      status: "verified";
      url_origin: string;
      pathname_recipe: string;
      bindings: {
        route_origin: CapturedUrlBinding;
        route_destination: CapturedUrlBinding;
        departure_date: CapturedUrlBinding;
        return_date: CapturedUrlBinding;
        trip_type: CapturedUrlBinding;
        nonstop: CapturedUrlBinding;
        adults: CapturedUrlBinding;
        cabin: CapturedUrlBinding;
      };
      example_url: string;
      evidence: string[];
    }
  | {
      status: "unavailable";
      reason: string;
      evidence: string[];
    };

interface CapturedUrlBinding {
  location: "path" | "query" | "fragment" | "encoded_payload";
  key_or_segment: string;
  captured_value: string;
}

interface Phase2Handoff {
  schema_version: 1;
  provider: "google" | "naver";
  canonical_fixture: string;
  final_case: CanonicalSearchCase;
  url_recipe: UrlRecipe;
  extraction_mode: "http" | "playwright";
}
```

- Google `canonical_fixture`는 `docs/spikes/fixtures/google-direct-round-trip.sanitized.json`, Naver는 `docs/spikes/fixtures/naver-direct-round-trip.sanitized.json`이다.
- `final_case`는 최초 제안 사례가 아니라 실제 G1/G2 3회 검증에 사용된 최종 사례다. profile의 `final_case`, findings의 `phase2_handoff.final_case`, 세 live 출력의 route/date는 모두 같아야 한다.
- Phase 2 provider/parser 테스트는 fixture의 `final_case`를 읽어 입력과 기대 route/date를 구성한다. `2026-10-08` 또는 `2026-10-12`를 테스트 코드에 직접 쓰면 contract 위반이다.
- `url_recipe.status`는 캡처에서 공식 검색 URL의 URL origin, pathname, 출발·도착, 출발·귀국일, 왕복, 직항, 성인 1, 이코노미 binding을 모두 증명한 경우에만 `verified`다. 각 binding은 실제 URL의 path/query/fragment/encoded payload 위치와 캡처 값을 기록한다.
- 하나라도 URL에서 검증할 수 없으면 `url_recipe.status = "unavailable"`로 두고 구체적 이유와 캡처 증거를 기록한다. 누락 parameter 이름, 위치, encoding, 기본값을 추측해서 recipe를 완성하지 않는다.
- `url_recipe`가 unavailable이어도 공식 결과 페이지 URL 자체와 quote 추출이 검증되면 G1/G2는 통과할 수 있다. 다만 Phase 2는 deep-link 구성 기능을 구현하지 않고 캡처된 공식 entry/result URL을 보존하며, URL recipe 지원은 재설계 대상으로 보고한다.

캡처 전에는 실제 endpoint, response shape, encoded payload, DOM selector를 알 수 없으므로 이 계획 본문에 완전한 source-specific extraction 코드를 미리 쓸 수 없다. 이를 generic behavior 목록으로 대체하지 않는다. Google/Naver 모두 캡처와 sanitized profile 생성 직후 source addendum를 필수 생성하고, addendum에 관찰된 profile shape 전용의 완전한 `scripts/spike-*.ts` 코드, offline test 절차, live 명령, 기대 결과를 넣는다. generic helper만으로 충분한 단순 shape여도 addendum에는 helper를 포함한 실행 가능한 전체 source file을 생략 없이 싣는다.

### Source addendum approval contract

- Google addendum: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md`
- Naver addendum: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md`
- addendum 생성 시 `**Status:** Review Required`로 기록한다.
- 구현 작업자가 아닌 사용자 또는 지정 reviewer만 캡처 증거, 보안, 완전 코드를 검토한 뒤 status를 정확히 `**Status:** Approved`로 바꿀 수 있다.
- `Status: Approved` 전에는 `scripts/spike-google.ts` 또는 `scripts/spike-naver.ts`를 생성·수정하거나 live 3회 검증을 시작하지 않는다. 상태가 미승인이면 `SOURCE ADDENDUM APPROVAL REQUIRED — STOP`을 보고한다.
- 승인 후 구현자는 addendum의 완전 코드 block을 해당 script에 그대로 적용한다. 관찰 shape가 바뀌어 코드 변경이 필요하면 script를 임의 수정하지 않고 addendum를 `Review Required`로 되돌려 새 코드와 검증 명령을 갱신하고 재승인을 받는다.
- addendum 자체가 writing-plans 실행 문서다. 정확한 create/modify/test 경로, checkbox RED/GREEN 단계, 완전한 source file 코드, offline/live 명령과 pass/fail, 보안 검사, commit 명령을 포함해야 한다.

### Sanitized profile

각 provider profile은 아래 두 형태 중 gate가 선택한 정확히 한 형태만 사용한다.

HTTP 형태:

```ts
interface HttpSpikeProfile {
  provider: "google" | "naver";
  mode: "http";
  final_case: CanonicalSearchCase;
  url_recipe: UrlRecipe;
  request: {
    method: "GET" | "POST";
    url: string;
    headers: Record<string, string>;
    body: string | null;
  };
  extraction: {
    rowsPath: string[];
    directPath: string[];
    directValue: string | number | boolean;
    pricePath: string[];
    currencyPath: string[];
    urlPath: string[];
  };
  sample: unknown;
}
```

Playwright 형태:

```ts
interface PlaywrightSpikeProfile {
  provider: "google" | "naver";
  mode: "playwright";
  final_case: CanonicalSearchCase;
  url_recipe: UrlRecipe;
  page: {
    url: string;
    readySelector: string;
    rowSelector: string;
    directSelector: string;
    directText: string;
    priceSelector: string;
    currencyToken: string;
    linkSelector: string;
  };
  sample: {
    directText: string;
    priceText: string;
    href: string;
  };
}
```

`sample`에는 parser가 사용하는 최소 subtree 또는 최소 텍스트만 둔다. 전체 응답, 전체 HTML, HAR, 쿠키, 인증 header, opaque session token, 사용자 식별자, 검색 기록은 넣지 않는다.

## Execution DAG

```text
Phase 0 prerequisite check
            │
            ├──────────────┬──────────────┐
            ▼              ▼              ▼
Workstream A G3    Workstream B      Workstream C
date combinator    Google capture    Naver capture
                   → addendum        → addendum
                   → approval STOP   → approval STOP
                   → CLI + G1        → CLI + G2
            └──────────────┴──────────────┘
                           │
                           ▼
                  Phase 0 gate review
```

Workstream A/B/C는 서로 다른 파일만 수정하므로 prerequisite check 뒤 병렬 실행할 수 있다. gate review는 세 작업흐름의 commit과 검증 보고를 모두 받은 뒤 실행한다.

## Task 0: Verify prerequisites and isolate raw captures

**Files:**
- Create: none
- Modify: none
- Test: none

- [ ] **Step 1: Verify runtime and shared contracts**

Run:

```bash
node --version
npm --version
test -f package.json
test -f src/domain/types.ts
test -f vitest.config.ts
npm run typecheck
```

Expected: Node major version is 20 or greater and every command exits 0. 실패하면 저장소를 수정하지 않고 `BLOCKED: contracts/bootstrap prerequisite`로 보고한다.

- [ ] **Step 2: Create out-of-repository capture directories**

Run:

```bash
CAPTURE_ROOT="${TEMP:-/tmp}/search-way-phase0"
mkdir -p "$CAPTURE_ROOT/google" "$CAPTURE_ROOT/naver"
test ! -e docs/spikes/raw
printf '%s\n' "$CAPTURE_ROOT"
```

Expected: 두 임시 디렉터리가 생성되고 `docs/spikes/raw`는 존재하지 않는다.

## Workstream A — G3 Date Combinator

### Ownership

- `src/domain/date-combinator.ts`
- `tests/domain/date-combinator.test.ts`

### Forbidden Writes

- `scripts/**`
- `docs/spikes/**`
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md`
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md`
- `src/providers/**`
- `src/orchestrator/**`
- `src/jobs/**`
- `src/mcp/**`
- shared contract/config files

### Dependencies

- Task 0 통과
- `src/domain/types.ts`의 `FlexibleSearchRequest`, `DatePair`

### Contract

- 이 문서의 G3 date combinator 계약을 그대로 구현한다.

### Task 1: Drive the combinator with failing calendar tests

**Files:**
- Create: `tests/domain/date-combinator.test.ts`
- Test: `tests/domain/date-combinator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/date-combinator.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { generateDatePairs } from "../../src/domain/date-combinator.js";
import type { FlexibleSearchRequest } from "../../src/domain/types.js";

function request(
  overrides: Partial<FlexibleSearchRequest> = {},
): FlexibleSearchRequest {
  return {
    origin: "ICN",
    destination: "NRT",
    months: ["2026-10"],
    minTripDays: 2,
    maxTripDays: 2,
    departureWeekdays: [],
    returnWeekdays: [],
    ...overrides,
  };
}

describe("generateDatePairs", () => {
  it("uses inclusive trip days and allows return outside selected months", () => {
    const pairs = generateDatePairs(
      request({
        minTripDays: 5,
        maxTripDays: 5,
        departureWeekdays: [4],
        returnWeekdays: [1],
      }),
    );

    expect(pairs).toContainEqual({
      departureDate: "2026-10-01",
      returnDate: "2026-10-05",
      tripDays: 5,
    });
    expect(pairs).toContainEqual({
      departureDate: "2026-10-29",
      returnDate: "2026-11-02",
      tripDays: 5,
    });
  });

  it("applies departure and return weekday filters in UTC", () => {
    const pairs = generateDatePairs(
      request({
        minTripDays: 2,
        maxTripDays: 5,
        departureWeekdays: [5],
        returnWeekdays: [1],
      }),
    );

    expect(pairs).toEqual([
      { departureDate: "2026-10-02", returnDate: "2026-10-05", tripDays: 4 },
      { departureDate: "2026-10-09", returnDate: "2026-10-12", tripDays: 4 },
      { departureDate: "2026-10-16", returnDate: "2026-10-19", tripDays: 4 },
      { departureDate: "2026-10-23", returnDate: "2026-10-26", tripDays: 4 },
      { departureDate: "2026-10-30", returnDate: "2026-11-02", tripDays: 4 },
    ]);
  });

  it("includes February 29 in a leap year", () => {
    const pairs = generateDatePairs(
      request({
        months: ["2028-02"],
        minTripDays: 2,
        maxTripDays: 2,
      }),
    );

    expect(pairs).toHaveLength(29);
    expect(pairs).toContainEqual({
      departureDate: "2028-02-29",
      returnDate: "2028-03-01",
      tripDays: 2,
    });
  });

  it("does not include February 29 in a non-leap year", () => {
    const pairs = generateDatePairs(
      request({
        months: ["2027-02"],
        minTripDays: 2,
        maxTripDays: 2,
      }),
    );

    expect(pairs).toHaveLength(28);
    expect(pairs.some(({ departureDate }) => departureDate === "2027-02-29")).toBe(
      false,
    );
  });

  it("deduplicates repeated months and sorts by departure then return", () => {
    const pairs = generateDatePairs(
      request({
        months: ["2026-10", "2026-10"],
        minTripDays: 2,
        maxTripDays: 3,
      }),
    );

    expect(pairs).toHaveLength(62);
    expect(pairs.slice(0, 2)).toEqual([
      { departureDate: "2026-10-01", returnDate: "2026-10-02", tripDays: 2 },
      { departureDate: "2026-10-01", returnDate: "2026-10-03", tripDays: 3 },
    ]);
    expect(pairs.at(-1)).toEqual({
      departureDate: "2026-10-31",
      returnDate: "2026-11-02",
      tripDays: 3,
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/domain/date-combinator.test.ts
```

Expected: FAIL because `src/domain/date-combinator.ts` or its export does not exist. 다른 이유로 실패하면 구현을 시작하기 전에 test/import/config 문제를 바로잡는다.

### Task 2: Implement the minimum deterministic combinator

**Files:**
- Create: `src/domain/date-combinator.ts`
- Test: `tests/domain/date-combinator.test.ts`

- [ ] **Step 1: Write the minimum implementation**

Create `src/domain/date-combinator.ts`:

```ts
import type { DatePair, FlexibleSearchRequest } from "./types.js";

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseMonth(month: string): { year: number; monthIndex: number } {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) {
    throw new Error(`Invalid month: ${month}`);
  }

  return {
    year: Number(match[1]),
    monthIndex: Number(match[2]) - 1,
  };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function generateDatePairs(
  request: FlexibleSearchRequest,
): DatePair[] {
  const departureWeekdays = new Set(request.departureWeekdays);
  const returnWeekdays = new Set(request.returnWeekdays);
  const pairs = new Map<string, DatePair>();

  for (const month of [...new Set(request.months)].sort()) {
    const { year, monthIndex } = parseMonth(month);
    const daysInMonth = new Date(
      Date.UTC(year, monthIndex + 1, 0),
    ).getUTCDate();

    for (let day = 1; day <= daysInMonth; day += 1) {
      const departure = new Date(Date.UTC(year, monthIndex, day));
      if (
        departureWeekdays.size > 0 &&
        !departureWeekdays.has(departure.getUTCDay())
      ) {
        continue;
      }

      for (
        let tripDays = request.minTripDays;
        tripDays <= request.maxTripDays;
        tripDays += 1
      ) {
        const returnDate = new Date(
          departure.getTime() + (tripDays - 1) * DAY_MS,
        );
        if (
          returnWeekdays.size > 0 &&
          !returnWeekdays.has(returnDate.getUTCDay())
        ) {
          continue;
        }

        const pair: DatePair = {
          departureDate: formatDate(departure),
          returnDate: formatDate(returnDate),
          tripDays,
        };
        pairs.set(`${pair.departureDate}/${pair.returnDate}`, pair);
      }
    }
  }

  return [...pairs.values()].sort(
    (left, right) =>
      left.departureDate.localeCompare(right.departureDate) ||
      left.returnDate.localeCompare(right.returnDate),
  );
}
```

- [ ] **Step 2: Run focused tests and verify GREEN**

Run:

```bash
npm test -- tests/domain/date-combinator.test.ts
```

Expected: 1 test file and 5 tests PASS; no timezone-dependent failure.

- [ ] **Step 3: Verify typecheck and build**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both commands exit 0 with no diagnostics.

- [ ] **Step 4: Commit G3**

```bash
git add src/domain/date-combinator.ts tests/domain/date-combinator.test.ts
git diff --cached --check
git commit -m "feat: generate flexible flight date pairs"
```

Expected: commit succeeds and contains exactly the two owned files.

### Verification

```bash
npm test -- tests/domain/date-combinator.test.ts
npm run typecheck
npm run build
```

Expected: all commands exit 0; focused output reports 5 passing tests.

### Output

- changed files;
- RED failure reason;
- GREEN/typecheck/build results;
- G3 PASS or FAIL;
- contract mismatch or `BLOCKED`.

## Workstream B — G1 Google Live Spike

### Ownership

- `scripts/spike-google.ts`
- `docs/spikes/2026-07-14-google-findings.md`
- `docs/spikes/fixtures/google-direct-round-trip.sanitized.json`
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md`

### Forbidden Writes

- Workstream A/C files
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md`
- `src/**`, `tests/**`
- shared contract/config files
- raw capture files anywhere in the repository
- `docs/**` except the owned Google findings, fixture, and source addendum

### Dependencies

- Task 0 통과
- Google Flights 공식 UI의 고정 검증 사례 검색 가능
- Google CLI 구현과 live G1은 Google source addendum의 external approval 이후에만 실행 가능

### Contract

- 이 문서의 spike CLI와 sanitized profile 계약을 사용한다.
- profile의 endpoint/path/selector는 DevTools에서 관찰한 값이어야 하며 사전 지식으로 추정하지 않는다.
- approved Google addendum의 complete source code가 `scripts/spike-google.ts`의 유일한 구현 계약이다.

### Task 3: Capture and classify the Google data path

**Files:**
- Create: `docs/spikes/2026-07-14-google-findings.md`
- Create: `docs/spikes/fixtures/google-direct-round-trip.sanitized.json`
- Create: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md`
- Test: `${TEMP:-/tmp}/search-way-phase0/google/google.har`

- [ ] **Step 1: Capture the official browser flow**

Run before opening DevTools:

```bash
CAPTURE_ROOT="${TEMP:-/tmp}/search-way-phase0"
mkdir -p "$CAPTURE_ROOT/google"
rm -f "$CAPTURE_ROOT/google/google.har"
```

In a fresh browser context, open official Google Flights, open DevTools Network, enable Preserve log and Disable cache, clear the log, and search the proposed case with round trip, adult 1, economy, nonstop. If it has no direct result, select the nearest future direct case and treat that captured case as `final_case`. Save **HAR with content** as `${TEMP:-/tmp}/search-way-phase0/google/google.har`.

Expected: the official UI visibly shows the selected airports/dates/nonstop condition and either a direct round-trip price or a no-result state; the HAR exists only outside the repository.

- [ ] **Step 2: Identify candidates from the capture without replaying guesses**

Run:

```bash
CAPTURE_ROOT="${TEMP:-/tmp}/search-way-phase0"
GOOGLE_HAR="$CAPTURE_ROOT/google/google.har" node <<'NODE'
const fs = require("node:fs");
const har = JSON.parse(fs.readFileSync(process.env.GOOGLE_HAR, "utf8"));
for (const entry of har.log.entries) {
  const type = entry.response?.content?.mimeType ?? "";
  const raw = entry.response?.content?.text ?? "";
  const text =
    entry.response?.content?.encoding === "base64"
      ? Buffer.from(raw, "base64").toString("utf8")
      : raw;
  if (
    /json|javascript|html/i.test(type) &&
    (text.includes("KRW") || text.includes("₩") || /non.?stop|직항/i.test(text))
  ) {
    console.log(
      JSON.stringify({
        method: entry.request.method,
        url: entry.request.url,
        status: entry.response.status,
        mimeType: type,
        bytes: text.length,
      }),
    );
  }
}
NODE
```

Expected: zero or more candidate requests are listed from the captured HAR. Zero candidates is evidence for the Playwright branch, not permission to invent an endpoint.

- [ ] **Step 3: Apply the HTTP/Playwright branch gate**

Choose **HTTP** only when one captured request satisfies all of these:

1. removing `cookie`, `authorization`, `proxy-authorization`, `set-cookie`, CSRF/session headers, and opaque per-session query/body values still yields a 2xx response in a fresh shell;
2. request inputs visibly encode the fixed airports, dates, adult 1, economy, and nonstop condition;
3. response data contains a direct-flight marker, numeric price, KRW marker, and an official Google result/search URL;
4. the same credential-free request succeeds twice before CLI implementation;
5. the minimal request and response subtree can be committed without identity, cookie, credential, or unrelated browsing data.

Choose **Playwright** when any HTTP condition fails but a fresh anonymous browser context can reach the fixed result and stable captured DOM selectors expose direct marker, price, and official link without captcha, login, or manual intervention.

Set G1 to **FAIL** when neither branch qualifies. On FAIL, write the observed status codes/UI blocker and sanitized structural evidence to findings, do not create a guessed profile, skip Task 4, and proceed directly to the STOP rule in Task 7.

- [ ] **Step 4: Write canonical, sanitized discovery artifacts**

Create the profile in the selected schema using values copied from the successful capture. Set `final_case` to the exact case that produced the captured direct result and set `url_recipe` to `verified` or `unavailable` under the Phase 2 canonical handoff rules. HTTP headers use an allowlist containing only `accept`, `accept-language`, `content-type`, `origin`, `referer`, and a non-identifying `user-agent`; omit headers not needed by the successful replay. The sample contains only fields traversed by `extraction`, or only the three selected DOM texts in Playwright mode.

Create `docs/spikes/2026-07-14-google-findings.md` with:

- 최초 제안 사례, 구조화된 `phase2_handoff.final_case`, capture timestamp;
- canonical fixture path;
- official entry URL;
- captured URL component inspection and either exact verified URL recipe or explicit `url_recipe unavailable` evidence;
- candidate request evidence;
- the result of every HTTP gate condition;
- selected mode and why the other mode was rejected;
- exact extraction paths or selectors copied into the profile;
- sanitization removals;
- pre-CLI replay results;
- known failure signatures;
- final three-attempt table after Task 5;
- G1 PASS or FAIL.

The `## Phase 2 Handoff` JSON block must conform to `Phase2Handoff`, name the Google canonical fixture, and match the profile's `final_case`, `url_recipe`, and mode. Do not write the proposed dates into this block unless those dates produced the actual direct result.

Run:

```bash
if rg -n -i "cookie|authorization|set-cookie|csrf|token|email|phone" \
  docs/spikes/fixtures/google-direct-round-trip.sanitized.json \
  docs/spikes/2026-07-14-google-findings.md; then
  printf '%s\n' "Review every match and remove sensitive values"
else
  printf '%s\n' "No sensitive markers found"
fi
```

Expected: no credential or personal-data value is present. A match that is only a findings sentence documenting removal is allowed after manual inspection; any match inside the JSON profile fails sanitization.

- [ ] **Step 5: Commit Google discovery**

```bash
git add docs/spikes/2026-07-14-google-findings.md docs/spikes/fixtures/google-direct-round-trip.sanitized.json
git diff --cached --check
git diff --cached --name-only
git commit -m "docs: record sanitized Google flight discovery"
```

Expected: only the two owned discovery files are committed; no HAR or raw response is staged.

- [ ] **Step 6: Author the mandatory Google source addendum**

Create `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md` immediately after the sanitized profile is fixed. The addendum must contain:

1. writing-plans header and checkbox steps;
2. `**Status:** Review Required`;
3. exact Ownership (`scripts/spike-google.ts`, Google findings/profile, this addendum) and all other files as Forbidden Writes;
4. links to the exact findings/profile and a structural description of the observed HTTP response or Playwright DOM/network shape;
5. the exact `final_case`, mode, URL recipe status, endpoint or page URL source, extraction paths/selectors, and sanitization assumptions copied from the canonical artifacts;
6. `<!-- BEGIN SOURCE: scripts/spike-google.ts -->` and `<!-- END SOURCE: scripts/spike-google.ts -->` around one TypeScript fence containing the complete executable `scripts/spike-google.ts` file with imports, types, argument parsing, profile validation, offline path, live path, extraction, output validation, timeout, errors, and cleanup—no omitted branches, ellipses, pseudocode, or behavior-only prose;
7. the normalized SHA-256 of that complete source as `**Normalized source SHA-256:** \`64 lowercase hex characters\``;
8. exact RED command, source extraction command, hash verification command, offline command with expected JSON assertions, live single-run command, three-consecutive-run command, security scan, and commit command;
9. HTTP or Playwright dependency/install command actually required by the observed mode;
10. pass/fail criteria matching G1 and the canonical `final_case`.

Even if the observed profile can be handled by a small generic walker, the addendum must include that helper and all Google-specific wiring as a complete source file.

After calculating the source hash, update Google findings with a structured `source_addendum` object containing the exact addendum path, `status: "Review Required"`, and normalized source SHA-256.

- [ ] **Step 7: Commit the review-required Google addendum**

```bash
git add \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md \
  docs/spikes/2026-07-14-google-findings.md
git diff --cached --check
git commit -m "docs: add Google Phase 0 source plan"
```

Expected: the addendum and matching findings linkage are committed with `Status: Review Required`; `scripts/spike-google.ts` still does not exist.

- [ ] **Step 8: Enforce external approval STOP**

The implementation worker stops and asks the user or designated reviewer to inspect the addendum against the sanitized profile. The approver changes only reviewed planning content, sets the exact addendum line `**Status:** Approved`, updates findings `source_addendum.status` to `"Approved"`, then commits:

```bash
git add \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md \
  docs/spikes/2026-07-14-google-findings.md
git diff --cached --check
git commit -m "docs: approve Google Phase 0 source plan"
```

Before approval, report `GOOGLE SOURCE ADDENDUM APPROVAL REQUIRED — STOP`. Resume only when this command exits 0:

```bash
rg -x '\*\*Status:\*\* Approved' \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md
```

### Task 4: Implement the Google replay CLI

**Files:**
- Create: `scripts/spike-google.ts`
- Modify: `docs/spikes/2026-07-14-google-findings.md`
- Test: `docs/spikes/fixtures/google-direct-round-trip.sanitized.json`
- Test: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md`

- [ ] **Step 1: Recheck addendum approval**

```bash
rg -x '\*\*Status:\*\* Approved' \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md
test ! -e scripts/spike-google.ts
```

Expected: both commands exit 0. Otherwise STOP without implementing.

- [ ] **Step 2: Verify RED before adding the CLI**

Run:

```bash
npm run spike:google -- --profile docs/spikes/fixtures/google-direct-round-trip.sanitized.json --attempt 1
```

Expected: FAIL because `scripts/spike-google.ts` does not exist.

- [ ] **Step 3: Extract the complete approved source**

Run the dependency command from the approved addendum, then extract its complete source block verbatim:

```bash
ADDENDUM="docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md" \
TARGET="scripts/spike-google.ts" node <<'NODE'
const fs = require("node:fs");
const addendum = fs.readFileSync(process.env.ADDENDUM, "utf8");
const match = /<!-- BEGIN SOURCE: scripts\/spike-google\.ts -->\r?\n```ts\r?\n([\s\S]*?)\r?\n```\r?\n<!-- END SOURCE: scripts\/spike-google\.ts -->/.exec(addendum);
if (match === null) throw new Error("complete Google source block not found");
fs.mkdirSync("scripts", { recursive: true });
fs.writeFileSync(process.env.TARGET, `${match[1].replace(/\r\n/g, "\n")}\n`);
NODE
```

Verify the normalized source hash:

```bash
ADDENDUM="docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md" \
TARGET="scripts/spike-google.ts" node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const addendum = fs.readFileSync(process.env.ADDENDUM, "utf8");
const expected = /\*\*Normalized source SHA-256:\*\* `([a-f0-9]{64})`/.exec(addendum)?.[1];
if (expected === undefined) throw new Error("approved source hash not found");
const source = fs.readFileSync(process.env.TARGET, "utf8").replace(/\r\n/g, "\n");
const actual = crypto.createHash("sha256").update(source).digest("hex");
if (actual !== expected) throw new Error(`source hash mismatch: ${actual}`);
console.log("Approved Google source hash verified");
NODE
```

Expected: extraction and hash verification exit 0. Any source change requires addendum update and reapproval.

- [ ] **Step 4: Run the approved addendum's offline verification**

Run:

```bash
npm run spike:google -- --profile docs/spikes/fixtures/google-direct-round-trip.sanitized.json --attempt 1 --offline
```

Also run every offline assertion command from the approved addendum.

Expected: addendum-defined offline checks exit 0 with provider `google`, canonical `final_case`, direct true, positive integer price, KRW, and official Google HTTPS URL; no network/browser request occurs.

### Task 5: Prove Google live feasibility three consecutive times

**Files:**
- Modify: `docs/spikes/2026-07-14-google-findings.md`
- Test: `scripts/spike-google.ts`
- Test: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md`

- [ ] **Step 1: Run three fresh live attempts**

First run the approved Google addendum's exact three-consecutive-run command. Then run the parent gate validator below as an independent contract check. Both are permitted only after the approved source has been extracted, hash-verified, and passed all addendum offline tests.

```bash
set -o pipefail
CAPTURE_ROOT="${TEMP:-/tmp}/search-way-phase0"
GOOGLE_LOG="$CAPTURE_ROOT/google/google-live.ndjson"
rm -f "$GOOGLE_LOG"
for attempt in 1 2 3; do
  npm run spike:google -- \
    --profile docs/spikes/fixtures/google-direct-round-trip.sanitized.json \
    --attempt "$attempt" | tee -a "$GOOGLE_LOG" || exit 1
  sleep 10
done
GOOGLE_LOG="$GOOGLE_LOG" \
GOOGLE_PROFILE="docs/spikes/fixtures/google-direct-round-trip.sanitized.json" \
node <<'NODE'
const fs = require("node:fs");
const finalCase = JSON.parse(
  fs.readFileSync(process.env.GOOGLE_PROFILE, "utf8"),
).final_case;
const rows = fs
  .readFileSync(process.env.GOOGLE_LOG, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line));
if (rows.length !== 3) throw new Error(`expected 3 outputs, got ${rows.length}`);
for (const [index, row] of rows.entries()) {
  if (
    row.provider !== "google" ||
    row.attempt !== index + 1 ||
    row.origin !== finalCase.origin ||
    row.destination !== finalCase.destination ||
    row.departureDate !== finalCase.departure_date ||
    row.returnDate !== finalCase.return_date ||
    row.direct !== true ||
    !Number.isInteger(row.price) ||
    row.price <= 0 ||
    row.currency !== "KRW" ||
    !/^https:\/\/([^.]+\.)*google\.com\//.test(row.url)
  ) {
    throw new Error(`invalid attempt ${index + 1}`);
  }
}
console.log("G1 PASS: 3 consecutive live attempts using canonical final_case");
NODE
```

Expected: all three CLI processes exit 0 and validator prints `G1 PASS: 3 consecutive live attempts`. 한 번이라도 실패하면 연속성은 깨진다. 원인을 findings에 기록하고 수정 후 attempt 1부터 다시 실행하며, 부분 성공을 합쳐 3회로 세지 않는다.

- [ ] **Step 2: Record evidence and commit**

Record mode, `final_case`, attempt timestamps, status, direct evidence, currency, official URL host, and pass/fail in findings. Verify that all three outputs match `phase2_handoff.final_case`. Raw log and raw prices need not be committed.

```bash
git add scripts/spike-google.ts docs/spikes/2026-07-14-google-findings.md
git diff --cached --check
git commit -m "test: prove Google flight spike feasibility"
```

Expected: commit contains only the Google CLI and findings update.

### Verification

```bash
npm run spike:google -- --profile docs/spikes/fixtures/google-direct-round-trip.sanitized.json --attempt 1 --offline
```

Then run the exact three-attempt command in Task 5.

### Output

- selected mode and gate evidence;
- approved Google addendum path, approval commit, and verified source hash;
- changed files;
- sanitization scan result;
- offline parser result;
- three consecutive live results;
- G1 PASS or FAIL;
- contract mismatch or `BLOCKED`.

## Workstream C — G2 Naver Live Spike

### Ownership

- `scripts/spike-naver.ts`
- `docs/spikes/2026-07-14-naver-findings.md`
- `docs/spikes/fixtures/naver-direct-round-trip.sanitized.json`
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md`

### Forbidden Writes

- Workstream A/B files
- `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md`
- `src/**`, `tests/**`
- shared contract/config files
- raw capture files anywhere in the repository
- `docs/**` except the owned Naver findings, fixture, and source addendum

### Dependencies

- Task 0 통과
- Naver Flights 공식 UI의 고정 검증 사례 검색 가능
- Naver CLI 구현과 live G2는 Naver source addendum의 external approval 이후에만 실행 가능

### Contract

- 이 문서의 spike CLI와 sanitized profile 계약을 사용한다.
- profile의 endpoint/path/selector는 DevTools에서 관찰한 값이어야 하며 사전 지식으로 추정하지 않는다.
- approved Naver addendum의 complete source code가 `scripts/spike-naver.ts`의 유일한 구현 계약이다.

### Task 6: Discover, implement, and prove the Naver path

**Files:**
- Create: `scripts/spike-naver.ts`
- Create: `docs/spikes/2026-07-14-naver-findings.md`
- Create: `docs/spikes/fixtures/naver-direct-round-trip.sanitized.json`
- Create: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md`
- Test: `${TEMP:-/tmp}/search-way-phase0/naver/naver.har`

- [ ] **Step 1: Capture the official browser flow**

```bash
CAPTURE_ROOT="${TEMP:-/tmp}/search-way-phase0"
mkdir -p "$CAPTURE_ROOT/naver"
rm -f "$CAPTURE_ROOT/naver/naver.har"
```

In a fresh browser context, open official Naver Flights, enable Preserve log and Disable cache in DevTools Network, clear the log, and search the proposed case with round trip, adult 1, economy, nonstop. If it has no direct result, select the nearest future direct case and treat that captured case as `final_case`. Save HAR with content as `${TEMP:-/tmp}/search-way-phase0/naver/naver.har`.

Expected: official UI and out-of-repository HAR show the fixed search or an explicit no-result state.

- [ ] **Step 2: List only captured candidates**

```bash
CAPTURE_ROOT="${TEMP:-/tmp}/search-way-phase0"
NAVER_HAR="$CAPTURE_ROOT/naver/naver.har" node <<'NODE'
const fs = require("node:fs");
const har = JSON.parse(fs.readFileSync(process.env.NAVER_HAR, "utf8"));
for (const entry of har.log.entries) {
  const type = entry.response?.content?.mimeType ?? "";
  const raw = entry.response?.content?.text ?? "";
  const text =
    entry.response?.content?.encoding === "base64"
      ? Buffer.from(raw, "base64").toString("utf8")
      : raw;
  if (
    /json|javascript|html/i.test(type) &&
    (text.includes("KRW") || text.includes("₩") || /non.?stop|직항/i.test(text))
  ) {
    console.log(
      JSON.stringify({
        method: entry.request.method,
        url: entry.request.url,
        status: entry.response.status,
        mimeType: type,
        bytes: text.length,
      }),
    );
  }
}
NODE
```

Expected: only requests present in the HAR are listed. Empty output routes the workstream toward Playwright.

- [ ] **Step 3: Apply the same deterministic branch gate**

Choose HTTP only if a captured request remains 2xx without cookie/auth/session/CSRF material, encodes every fixed search condition, exposes direct marker + numeric price + KRW + official Naver URL, succeeds twice in fresh shells, and can be reduced to a safe minimal sample.

Choose Playwright if HTTP fails but a fresh anonymous context can extract all required fields through stable captured selectors without captcha, login, or manual action.

Set G2 to FAIL if neither qualifies. Document sanitized failure evidence, do not invent an endpoint or selector, skip implementation/live reruns, and apply Task 7 STOP.

- [ ] **Step 4: Create canonical, sanitized Naver artifacts**

Create the selected profile from captured values. Set `final_case` to the exact case that produced the captured direct result and set `url_recipe` under the Phase 2 handoff rules. Write `docs/spikes/2026-07-14-naver-findings.md` with the initial proposed case, structured `phase2_handoff.final_case`, canonical fixture path, capture timestamp, official entry URL, captured URL component inspection, exact verified URL recipe or explicit unavailable evidence, candidate request evidence, each HTTP gate result, selected mode and rejected-mode reason, exact captured extraction paths or selectors, sanitization removals, pre-CLI replay results, known failure signatures, final three-attempt table, and G2 PASS/FAIL. Use only the HTTP header allowlist and minimal sample contract defined above.

The `## Phase 2 Handoff` JSON block must conform to `Phase2Handoff`, name the Naver canonical fixture, and match the profile's `final_case`, `url_recipe`, and mode. The initial proposed dates are not canonical unless they produced the actual direct result.

```bash
if rg -n -i "cookie|authorization|set-cookie|csrf|token|email|phone" \
  docs/spikes/fixtures/naver-direct-round-trip.sanitized.json \
  docs/spikes/2026-07-14-naver-findings.md; then
  printf '%s\n' "Review every match and remove sensitive values"
else
  printf '%s\n' "No sensitive markers found"
fi
```

Expected: no secret or personal-data value in JSON; only manually verified prose about removed categories may match in findings.

- [ ] **Step 5: Commit Naver discovery**

```bash
git add docs/spikes/2026-07-14-naver-findings.md docs/spikes/fixtures/naver-direct-round-trip.sanitized.json
git diff --cached --check
git diff --cached --name-only
git commit -m "docs: record sanitized Naver flight discovery"
```

Expected: only the Naver findings and profile are committed.

- [ ] **Step 6: Author the mandatory Naver source addendum**

Create `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md` immediately after the sanitized profile is fixed. It must contain the same ten mandatory categories defined for the Google addendum, specialized to Naver:

- writing-plans header, checkbox steps, and `**Status:** Review Required`;
- exact Naver ownership and forbidden writes;
- observed Naver profile/shape and canonical handoff;
- one complete executable TypeScript file between `<!-- BEGIN SOURCE: scripts/spike-naver.ts -->` and `<!-- END SOURCE: scripts/spike-naver.ts -->`;
- normalized SHA-256;
- exact dependency, RED, extraction, hash, offline, live single-run, three-run, security, and commit commands;
- G2 pass/fail criteria using Naver's `final_case`.

The source block must include all imports, types, argument parsing, validation, offline/live branches, observed-shape extraction, output checks, timeout, error behavior, and cleanup. It may contain a generic helper only when that helper and every Naver-specific caller are present as complete code.

After calculating the source hash, update Naver findings with a structured `source_addendum` object containing the exact path, `status: "Review Required"`, and normalized source SHA-256.

- [ ] **Step 7: Commit the review-required Naver addendum**

```bash
git add \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md \
  docs/spikes/2026-07-14-naver-findings.md
git diff --cached --check
git commit -m "docs: add Naver Phase 0 source plan"
```

Expected: the Naver addendum and matching findings linkage are committed; status is Review Required and the Naver script does not exist.

- [ ] **Step 8: Enforce external approval STOP**

The user or designated reviewer inspects the addendum against the Naver profile, changes the exact status line to `**Status:** Approved`, updates findings `source_addendum.status` to `"Approved"`, and commits:

```bash
git add \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md \
  docs/spikes/2026-07-14-naver-findings.md
git diff --cached --check
git commit -m "docs: approve Naver Phase 0 source plan"
```

Before approval, report `NAVER SOURCE ADDENDUM APPROVAL REQUIRED — STOP`. Resume only when:

```bash
rg -x '\*\*Status:\*\* Approved' \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md
```

- [ ] **Step 9: Recheck addendum approval**

```bash
rg -x '\*\*Status:\*\* Approved' \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md
test ! -e scripts/spike-naver.ts
```

Expected: both commands exit 0. Otherwise STOP without implementing.

- [ ] **Step 10: Verify RED before adding the CLI**

```bash
npm run spike:naver -- --profile docs/spikes/fixtures/naver-direct-round-trip.sanitized.json --attempt 1
```

Expected before implementation: FAIL because `scripts/spike-naver.ts` does not exist.

- [ ] **Step 11: Extract and verify the complete approved source**

Run the dependency command from the approved addendum, then:

```bash
ADDENDUM="docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md" \
TARGET="scripts/spike-naver.ts" node <<'NODE'
const fs = require("node:fs");
const addendum = fs.readFileSync(process.env.ADDENDUM, "utf8");
const match = /<!-- BEGIN SOURCE: scripts\/spike-naver\.ts -->\r?\n```ts\r?\n([\s\S]*?)\r?\n```\r?\n<!-- END SOURCE: scripts\/spike-naver\.ts -->/.exec(addendum);
if (match === null) throw new Error("complete Naver source block not found");
fs.mkdirSync("scripts", { recursive: true });
fs.writeFileSync(process.env.TARGET, `${match[1].replace(/\r\n/g, "\n")}\n`);
NODE
ADDENDUM="docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md" \
TARGET="scripts/spike-naver.ts" node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const addendum = fs.readFileSync(process.env.ADDENDUM, "utf8");
const expected = /\*\*Normalized source SHA-256:\*\* `([a-f0-9]{64})`/.exec(addendum)?.[1];
if (expected === undefined) throw new Error("approved source hash not found");
const source = fs.readFileSync(process.env.TARGET, "utf8").replace(/\r\n/g, "\n");
const actual = crypto.createHash("sha256").update(source).digest("hex");
if (actual !== expected) throw new Error(`source hash mismatch: ${actual}`);
console.log("Approved Naver source hash verified");
NODE
```

Expected: source extraction and hash verification exit 0. Any code change returns the addendum to Review Required.

- [ ] **Step 12: Run the approved addendum's offline verification**

```bash
npm run spike:naver -- --profile docs/spikes/fixtures/naver-direct-round-trip.sanitized.json --attempt 1 --offline
```

Run every additional offline assertion command from the approved addendum.

Expected: exit 0 with provider `naver`, canonical `final_case`, direct true, positive integer price, KRW, and official Naver HTTPS URL; no network/browser use.

- [ ] **Step 13: Run three fresh live attempts**

First run the approved Naver addendum's exact three-consecutive-run command. Then run the validator below independently. Both commands are forbidden before addendum approval, exact source extraction, hash verification, and offline GREEN.

```bash
set -o pipefail
CAPTURE_ROOT="${TEMP:-/tmp}/search-way-phase0"
NAVER_LOG="$CAPTURE_ROOT/naver/naver-live.ndjson"
rm -f "$NAVER_LOG"
for attempt in 1 2 3; do
  npm run spike:naver -- \
    --profile docs/spikes/fixtures/naver-direct-round-trip.sanitized.json \
    --attempt "$attempt" | tee -a "$NAVER_LOG" || exit 1
  sleep 10
done
NAVER_LOG="$NAVER_LOG" \
NAVER_PROFILE="docs/spikes/fixtures/naver-direct-round-trip.sanitized.json" \
node <<'NODE'
const fs = require("node:fs");
const finalCase = JSON.parse(
  fs.readFileSync(process.env.NAVER_PROFILE, "utf8"),
).final_case;
const rows = fs
  .readFileSync(process.env.NAVER_LOG, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line));
if (rows.length !== 3) throw new Error(`expected 3 outputs, got ${rows.length}`);
for (const [index, row] of rows.entries()) {
  if (
    row.provider !== "naver" ||
    row.attempt !== index + 1 ||
    row.origin !== finalCase.origin ||
    row.destination !== finalCase.destination ||
    row.departureDate !== finalCase.departure_date ||
    row.returnDate !== finalCase.return_date ||
    row.direct !== true ||
    !Number.isInteger(row.price) ||
    row.price <= 0 ||
    row.currency !== "KRW" ||
    !/^https:\/\/([^.]+\.)*naver\.com\//.test(row.url)
  ) {
    throw new Error(`invalid attempt ${index + 1}`);
  }
}
console.log("G2 PASS: 3 consecutive live attempts using canonical final_case");
NODE
```

Expected: validator prints `G2 PASS: 3 consecutive live attempts`. Any failure resets the consecutive count to zero; diagnose, update owned artifacts, and rerun from attempt 1.

- [ ] **Step 14: Record final evidence and commit**

Record `final_case`, mode, attempt timestamps, status, direct evidence, currency, official URL host, and pass/fail in findings. Confirm all three outputs match `phase2_handoff.final_case`.

```bash
git add scripts/spike-naver.ts docs/spikes/2026-07-14-naver-findings.md
git diff --cached --check
git commit -m "test: prove Naver flight spike feasibility"
```

Expected: only Naver-owned files are committed.

### Verification

Run the offline command and exact three-attempt command from Task 6.

### Output

- selected mode and gate evidence;
- approved Naver addendum path, approval commit, and verified source hash;
- changed files;
- sanitization scan result;
- offline parser result;
- three consecutive live results;
- G2 PASS or FAIL;
- contract mismatch or `BLOCKED`.

## Task 7: Review the Phase 0 gate and enforce STOP

**Files:**
- Modify: none
- Test: all owned implementation files

- [ ] **Step 1: Inspect workstream reports and write-set separation**

Run:

```bash
git status --short
git log --oneline --name-only -16
```

Expected: discovery, addendum, approval, implementation commits changed only their workstream Ownership files; raw capture paths and shared contract/config files do not appear.

- [ ] **Step 2: Validate canonical handoff and URL evidence**

Run this step only when both canonical profile files exist. If a provider failed before a safe profile could be created, record the missing canonical artifact, skip to Step 5 STOP, then always perform Steps 6–7.

Run:

```bash
rg -x '\*\*Status:\*\* Approved' \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md
rg -x '\*\*Status:\*\* Approved' \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md
node <<'NODE'
const fs = require("node:fs");
const profiles = [
  ["google", "docs/spikes/fixtures/google-direct-round-trip.sanitized.json"],
  ["naver", "docs/spikes/fixtures/naver-direct-round-trip.sanitized.json"],
];
const caseKeys = [
  "origin",
  "destination",
  "departure_date",
  "return_date",
  "adults",
  "cabin",
  "trip_type",
  "nonstop",
];
const bindingKeys = [
  "route_origin",
  "route_destination",
  "departure_date",
  "return_date",
  "trip_type",
  "nonstop",
  "adults",
  "cabin",
];
for (const [provider, path] of profiles) {
  const profile = JSON.parse(fs.readFileSync(path, "utf8"));
  if (profile.provider !== provider) throw new Error(`${provider}: provider mismatch`);
  for (const key of caseKeys) {
    if (!(key in profile.final_case)) throw new Error(`${provider}: missing final_case.${key}`);
  }
  if (
    profile.final_case.adults !== 1 ||
    profile.final_case.cabin !== "economy" ||
    profile.final_case.trip_type !== "round_trip" ||
    profile.final_case.nonstop !== true
  ) {
    throw new Error(`${provider}: final_case fixed constraints mismatch`);
  }
  const recipe = profile.url_recipe;
  if (recipe.status === "verified") {
    new URL(recipe.example_url);
    if (new URL(recipe.example_url).origin !== recipe.url_origin) {
      throw new Error(`${provider}: URL origin mismatch`);
    }
    for (const key of bindingKeys) {
      if (!recipe.bindings?.[key]) throw new Error(`${provider}: missing URL binding ${key}`);
    }
    if (!Array.isArray(recipe.evidence) || recipe.evidence.length === 0) {
      throw new Error(`${provider}: verified URL recipe lacks evidence`);
    }
  } else if (
    recipe.status !== "unavailable" ||
    typeof recipe.reason !== "string" ||
    recipe.reason.length === 0 ||
    !Array.isArray(recipe.evidence) ||
    recipe.evidence.length === 0
  ) {
    throw new Error(`${provider}: invalid unavailable URL evidence`);
  }
}
console.log("Canonical final_case and URL evidence valid");
NODE
```

Then inspect each findings `## Phase 2 Handoff` JSON block against its profile and verify each script against its approved addendum hash using the addendum's exact hash command. Expected: both addendums are Approved; provider, canonical fixture path, `final_case`, `url_recipe`, and extraction mode are equal; both script hashes match. A mismatch is a gate failure.

- [ ] **Step 3: Run offline project verification**

Run this step only after both source addendums are Approved and their complete source files have been extracted with matching hashes. If either addendum is not Approved, report `SOURCE ADDENDUM APPROVAL REQUIRED — STOP`; do not run offline/live CLI commands.

```bash
npm run typecheck
npm test -- tests/domain/date-combinator.test.ts
npm run build
npm run spike:google -- --profile docs/spikes/fixtures/google-direct-round-trip.sanitized.json --attempt 1 --offline
npm run spike:naver -- --profile docs/spikes/fixtures/naver-direct-round-trip.sanitized.json --attempt 1 --offline
```

Expected: all commands exit 0, G3 reports 5 passing tests, and offline spike checks make no live request.

- [ ] **Step 4: Re-run live gates without combining old partial runs**

Run the complete Google three-attempt block from Task 5 and complete Naver three-attempt block from Task 6 in the same gate-review session.

Expected: G1 and G2 each independently report 3 consecutive live successes for the exact `final_case` in their canonical fixture.

- [ ] **Step 5: Decide the gate**

PASS only when all are true:

- G1: Google returned direct true, positive integer price, KRW, and official URL in 3 consecutive fresh runs.
- G2: Naver returned the same required fields in 3 consecutive fresh runs.
- G3: all five combinator tests, typecheck, and build pass.
- both canonical fixtures contain complete `final_case`; findings handoff blocks match them; live outputs consume those cases rather than the proposed dates.
- each provider has either a fully captured `url_recipe.status = "verified"` recipe or explicit evidence-backed `url_recipe.status = "unavailable"`; no URL parameter is inferred.
- both source addendums exist, contain complete source/offline/live instructions, have external `Status: Approved`, and match their implemented script by normalized SHA-256.
- no raw HAR, credential, cookie, authorization material, opaque session token, or personal information is tracked.
- every changed file belongs to exactly one workstream.

If either addendum is not Approved, declare `PHASE 0 BLOCKED — SOURCE ADDENDUM APPROVAL REQUIRED — STOP`; G1/G2 live verification has not started and must not be reported as failed or passed.

If **G1 or G2 fails after approved addendum implementation**, declare `PHASE 0 FAIL — STOP`, do not start or authorize Phase 1/2/3/4, and return the approved addendum plus failed findings for a user decision to revise and reapprove source code, revise the acquisition method, remove that source, or revise the product specification. Do not weaken direct-flight, KRW, official URL, or 3-consecutive-run criteria.

If G3 alone fails, keep G1/G2 evidence but declare `PHASE 0 FAIL — STOP`, fix only Workstream A under its ownership, and rerun the whole Phase 0 gate after G3 passes.

- [ ] **Step 6: Run the credential and repository safety check**

```bash
git ls-files | rg -n '(^|/)(\.env|.*\.har|cookies?\.json|auth.*\.json)$' && exit 1 || true
rg -n -i \
  '(authorization|set-cookie|cookie:|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|email|phone)' \
  docs/spikes/fixtures \
  scripts/spike-google.ts scripts/spike-naver.ts \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md \
  docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-naver-source-addendum.md
git status --short
```

Expected: no tracked secret/raw-capture filename; no credential or personal-data value in committed artifacts; working tree contains no raw capture. Field-name matches in validation code require manual inspection and are acceptable only when no value is present.

- [ ] **Step 7: Delete raw captures after the gate decision**

Run this cleanup after PASS, FAIL, or SOURCE ADDENDUM APPROVAL REQUIRED. Sanitized canonical fixtures, findings, and addendums remain; raw HAR, raw responses, copied requests, and live logs are deleted.

```bash
CAPTURE_ROOT="${TEMP:-/tmp}/search-way-phase0"
case "$CAPTURE_ROOT" in
  */search-way-phase0) ;;
  *) printf '%s\n' "Refusing unsafe cleanup path: $CAPTURE_ROOT" >&2; exit 1 ;;
esac
rm -rf -- "$CAPTURE_ROOT"
test ! -e "$CAPTURE_ROOT"
printf '%s\n' "Raw Phase 0 captures removed"
```

Expected: command exits 0, `${TEMP:-/tmp}/search-way-phase0` no longer exists, and no repository file is deleted. Cleanup failure does not turn a failed source into a pass; report `CLEANUP BLOCKED` and remove the raw directory before handing the machine to another worker.

## Verification

Phase 0 final verification consists of:

```bash
npm run typecheck
npm test -- tests/domain/date-combinator.test.ts
npm run build
```

plus the exact Google and Naver three-attempt live blocks above.

Expected final result:

```text
Canonical final_case and URL evidence valid
G1 PASS: 3 consecutive live attempts using canonical final_case
G2 PASS: 3 consecutive live attempts using canonical final_case
G3 PASS: 5 focused tests + typecheck + build
Raw Phase 0 captures removed
PHASE 0 PASS
```

CI and default `npm test` must not execute a live provider request. Live commands remain manual Phase 0 gate commands.

## Output

Every workstream reports:

- changed files;
- commands run with pass/fail;
- RED and GREEN evidence where applicable;
- selected provider mode and branch-gate evidence;
- canonical fixture path and structured `final_case`;
- verified URL recipe or explicit unavailable evidence;
- source addendum path, status, complete-source hash, and approval commit;
- sanitization result;
- contract mismatch;
- `BLOCKED` instead of writing outside ownership.

The gate reviewer reports:

- G1, G2, G3 status separately;
- provider별 canonical fixture, `final_case`, and three-attempt timestamps;
- URL recipe status and evidence;
- both source addendum approval statuses and script hash results;
- final `PHASE 0 PASS` or `PHASE 0 FAIL — STOP`;
- on G1/G2 failure, the exact findings document and the required specification-review decision;
- confirmation that no credential, cookie, personal information, raw HAR, or raw response was committed;
- raw capture cleanup command result.
