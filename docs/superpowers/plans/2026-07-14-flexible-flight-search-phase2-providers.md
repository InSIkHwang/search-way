# Flexible Flight Search Phase 2 Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 0에서 검증된 수집 방식만 사용해 Google Flights와 Naver Flights의 직항 왕복 최저 KRW `FlightProvider` 어댑터를 fixture-first TDD로 구현한다.

**Architecture:** Google과 Naver를 쓰기 경로가 겹치지 않는 두 workstream으로 나누고, 각 source 안에서 수집 client, 순수 parser, provider 조립을 분리한다. Phase 0 findings가 HTTP를 확정한 source에는 `fetch` client 하나만, Playwright를 확정한 source에는 browser client 하나만 만들며, 기록·sanitization한 fixture를 parser와 provider contract test의 유일한 CI 입력으로 사용한다.

**Tech Stack:** Node.js 20+, TypeScript, native `fetch` 또는 Playwright 중 findings가 확정한 하나, Vitest, JSON/HTML sanitized fixtures

---

## Ownership

이 문서의 구현은 아래 두 write set만 소유한다. 병렬 작업자는 자기 source 경로 밖을 수정하지 않는다.

### Workstream G — Google provider

- `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase2-google-addendum.md`
- `src/providers/google/client.ts`
- `src/providers/google/parser.ts`
- `src/providers/google/provider.ts`
- `tests/providers/google/fixtures/manifest.json`
- `tests/providers/google/fixtures/direct-round-trip.json` 또는 `tests/providers/google/fixtures/direct-round-trip.html`
- `tests/providers/google/fixtures/synthetic-multiple-direct.json` 또는 `tests/providers/google/fixtures/synthetic-multiple-direct.html`
- `tests/providers/google/fixtures/synthetic-without-airline.json` 또는 `tests/providers/google/fixtures/synthetic-without-airline.html`
- `tests/providers/google/fixtures/no-direct-flight.json` 또는 `tests/providers/google/fixtures/no-direct-flight.html`
- `tests/providers/google/fixtures/malformed-response.json` 또는 `tests/providers/google/fixtures/malformed-response.html`
- `tests/providers/google/fixture-schema.test.ts`
- `tests/providers/google/client.contract.test.ts`
- `tests/providers/google/parser.contract.test.ts`
- `tests/providers/google/provider.contract.test.ts`

### Workstream N — Naver provider

- `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase2-naver-addendum.md`
- `src/providers/naver/client.ts`
- `src/providers/naver/parser.ts`
- `src/providers/naver/provider.ts`
- `tests/providers/naver/fixtures/manifest.json`
- `tests/providers/naver/fixtures/direct-round-trip.json` 또는 `tests/providers/naver/fixtures/direct-round-trip.html`
- `tests/providers/naver/fixtures/synthetic-multiple-direct.json` 또는 `tests/providers/naver/fixtures/synthetic-multiple-direct.html`
- `tests/providers/naver/fixtures/synthetic-without-airline.json` 또는 `tests/providers/naver/fixtures/synthetic-without-airline.html`
- `tests/providers/naver/fixtures/no-direct-flight.json` 또는 `tests/providers/naver/fixtures/no-direct-flight.html`
- `tests/providers/naver/fixtures/malformed-response.json` 또는 `tests/providers/naver/fixtures/malformed-response.html`
- `tests/providers/naver/fixture-schema.test.ts`
- `tests/providers/naver/client.contract.test.ts`
- `tests/providers/naver/parser.contract.test.ts`
- `tests/providers/naver/provider.contract.test.ts`

각 source에서 fixture 확장자는 Phase 0 findings의 실제 parser 입력에 따라 하나만 선택한다. HTTP JSON 또는 Playwright가 가로챈 network JSON이면 source-response fixture는 `.json`, Playwright stabilized DOM이면 `.html`이다. 같은 basename의 `.json`과 `.html`을 함께 만들지 않는다.

## Forbidden Writes

- `src/domain/**`
- `src/providers/types.ts`
- `src/orchestrator/**`
- `src/jobs/**`
- `src/mcp/**`
- Google 작업자에게 `src/providers/naver/**`, `tests/providers/naver/**`
- Naver 작업자에게 `src/providers/google/**`, `tests/providers/google/**`
- `scripts/**`
- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`
- `docs/spikes/**`
- 이 계획과 source별 승인 addendum를 제외한 `docs/**`

공유 타입이 findings와 맞지 않더라도 provider 작업자가 수정하지 않는다. 불일치한 필드와 필요한 계약 변경을 보고하고 `BLOCKED`로 종료한다.

## Dependencies

실행 전 아래 파일이 실제로 존재하고 서로 일치해야 한다.

1. `docs/superpowers/specs/2026-07-14-flexible-flight-search-design.md`
2. `docs/superpowers/plans/2026-07-14-flexible-flight-search-contracts.md`
3. `docs/superpowers/plans/2026-07-14-flexible-flight-search-master.md`
4. Google: `docs/spikes/2026-07-14-google-findings.md`
5. Naver: `docs/spikes/2026-07-14-naver-findings.md`
6. `src/providers/types.ts`
7. Phase 1 전체와 `npm run typecheck && npm test && npm run build` 통과 상태

현재 계획 작성 시점에는 두 findings 문서가 없을 수 있다. 이는 계획 작성의 blocker가 아니지만 Phase 2 구현 시작의 확정 blocker다. source별 findings가 없거나 G1/G2 3회 연속 성공, 직항 조건, 응답 식별 정보, fixture provenance 중 하나라도 모호하면 해당 workstream은 파일을 만들지 않고 `BLOCKED`를 보고한다.

## Contract

### 고정 공개 계약

두 provider 모두 기존 `src/providers/types.ts`를 수정하지 않고 아래 계약을 구현한다.

```ts
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

Google과 Naver의 입력은 각 findings의 `final_case`를 독립적으로 사용한다. 두 source의 route/date가 달라도 정상이다. 날짜나 공항을 이 계획에 고정하지 않고, source manifest의 `request`를 tests와 manual smoke가 읽는다.

```ts
interface ProviderFixtureManifest {
  source: "google" | "naver";
  finalCaseSource: string;
  request: ProviderSearchInput;
}

const manifest = JSON.parse(
  await readFile(new URL("./fixtures/manifest.json", import.meta.url), "utf8"),
) as ProviderFixtureManifest;
const contractInput = manifest.request;
```

### Source-local 오류 계약

두 source의 `provider.ts`는 같은 shape의 오류를 source-local로 정의한다. 공용 오류 타입은 추가하지 않는다.

```ts
export type ProviderFailureCode =
  | "provider_timeout"
  | "provider_blocked"
  | "no_direct_flight"
  | "provider_error";

export class ProviderFailure extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderFailure";
  }
}
```

분류 규칙:

- `AbortError` 또는 findings가 기록한 timeout 신호 → `provider_timeout`
- HTTP 403/429, CAPTCHA, consent/interstitial, findings가 기록한 차단 신호 → `provider_blocked`
- 정상 응답이지만 직항 왕복 후보가 없음 → `no_direct_flight`
- JSON decode 실패, 필수 노드 부재, 숫자가 아닌 가격, 비-KRW 가격, 잘못된 URL, 잘못된 시각 → `provider_error`

### Quote 불변식

- `price`: 안전한 양의 정수이며 직항 왕복 후보 중 최저 총액
- `currency`: 정확히 `"KRW"`; 다른 통화를 숫자만 비교하거나 변환하지 않음
- `airline`: findings 응답에서 안정적으로 확인되는 경우에만 존재; 없으면 property 자체를 생략
- `url`: `new URL(value)`가 성공하고 `http:` 또는 `https:`인 검색/예약 URL
- `scrapedAt`: client가 응답을 획득한 시각을 주입하며 parser가 `new Date(value).toISOString() === value`를 만족하도록 반환
- 정상 응답에 직항 왕복 후보가 하나도 없으면 quote를 조작하지 않고 `no_direct_flight`

### Client 선택 계약

각 source의 `client.ts`는 이름은 동일하지만 구현은 정확히 하나만 가진다.

```ts
export interface CapturedResponse {
  body: string;
  scrapedAt: string;
}

export interface SourceClient {
  search(
    input: ProviderSearchInput,
    signal?: AbortSignal,
  ): Promise<CapturedResponse>;
}
```

- findings의 `acquisition_mode: http`가 실제 method, endpoint, request encoding, 직항 parameter, 성인 1, economy, 왕복, 필수 header, 응답 종류를 모두 확정하면 `client.ts`에 native `fetch` 구현만 작성한다.
- findings의 `acquisition_mode: playwright`가 navigation URL, 직항 설정 절차, 안정적인 ready condition, 추출 대상 response 또는 DOM selector를 모두 확정하면 `client.ts`에 Playwright browser 구현만 작성한다.
- 두 방식이 모두 기록돼도 findings가 `selected_mode`로 선택한 하나만 구현한다.
- `selected_mode`가 없거나 evidence와 모순되면 `BLOCKED`; 두 client를 동시에 구현하거나 fallback chain을 만들지 않는다.
- endpoint, method, parameter 이름, selector, response JSON path는 이 계획의 예시로 발명하지 않는다. 모두 source findings의 확정값을 문자 단위로 옮기고 contract test에서 fixture와 대조한다.

Playwright selected mode는 browser/page factory 주입을 필수 constructor dependency로 둔다. production factory는 browser launch 전에 아래 guard를 반드시 호출한다.

```ts
export function assertProductionBrowserAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.VITEST !== undefined || env.CI !== undefined) {
    throw new Error(
      "production browser factory is disabled under VITEST or CI",
    );
  }
  if (env.SEARCH_WAY_ALLOW_LIVE_NETWORK !== "1") {
    throw new Error(
      "set SEARCH_WAY_ALLOW_LIVE_NETWORK=1 for manual live browser access",
    );
  }
}
```

- `ProductionBrowserFactory.createPage()`는 첫 줄에서 guard를 호출한 다음에만 Playwright를 launch한다.
- Vitest는 production factory를 client에 주입하지 않고 fake browser/page factory만 주입한다.
- production factory guard test는 `process.env.VITEST` 또는 `process.env.CI`가 존재할 때 명시적 오류와 launch spy 0회를 검증한다.
- guard test 중 하나는 env override를 넘기지 않아 Vitest가 설정한 실제 `process.env.VITEST` 경로를 실행한다.
- manual live smoke만 `SEARCH_WAY_ALLOW_LIVE_NETWORK=1`을 명시해 production factory를 허용한다.
- HTTP selected mode는 test에서 `globalThis.fetch`를 `vi.stubGlobal("fetch", fakeFetch)`로 교체한다. 실제 global fetch 또는 live URL을 호출하는 test는 금지한다.
- source별 client contract test는 default `npm test`에 포함되며 browser launch count와 live network call count가 각각 0임을 assertion한다.

## Parallel Execution Contract

```text
Phase 2 Gate 0: dependency/findings 검증
                    │
                    ▼
Phase 2 Gate 0.5: source addendum 작성·승인 STOP
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
Workstream G                 Workstream N
Google fixture/client/       Naver fixture/client/
parser/provider              parser/provider
        └───────────┬───────────┘
                    ▼
Phase 2 Gate 2: offline integration verification
```

- Gate 0는 각 source별로 독립이다. Google이 `BLOCKED`여도 Naver findings가 완전하면 Naver는 진행할 수 있지만 전체 Phase 2 exit gate는 통과하지 않는다.
- Gate 0.5에서 각 source addendum가 승인되기 전에는 해당 source의 fixture, test, production 파일을 만들지 않는다.
- 두 workstream의 write set은 완전히 분리된다.
- `src/providers/types.ts`와 테스트 설정은 읽기 전용 shared contract다.
- 새 dependency가 필요하면 provider 작업자가 `package.json`을 수정하지 않는다. Playwright가 selected mode인데 설치되어 있지 않으면 필요한 package와 근거를 보고하고 `BLOCKED`로 종료한다.
- 병렬 작업 종료 후 통합 담당자는 changed-file 목록의 교집합이 비어 있는지 확인한 뒤 전체 offline suite를 실행한다.

## Task 0: Gate findings and choose one acquisition mode

**Files:**
- Read: `docs/spikes/2026-07-14-google-findings.md`
- Read: `docs/spikes/2026-07-14-naver-findings.md`
- Read: `src/providers/types.ts`
- Create: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase2-google-addendum.md`
- Create: `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase2-naver-addendum.md`

- [ ] **Step 1: Verify Google findings completeness**

문서에서 아래 증거를 직접 찾아 기록한다.

```text
G1 result: PASS
Consecutive successes: 3
Final case: exact origin, destination, departureDate, returnDate, tripDays
Acquisition mode: http | playwright
Selected mode: http | playwright
Direct-only evidence: request/filter value plus returned itinerary stop-count evidence
Response identity: HTTP method + endpoint + response content type, or navigation URL + ready condition + response/DOM selector
Price evidence: exact response JSON path or DOM selector and integer KRW normalization rule
Currency evidence: exact path/selector and observed KRW marker
URL evidence: exact path/selector or evidenced deterministic construction rule
Airline evidence: exact optional path/selector or explicit unavailable finding
Blocked evidence: observed status/body/DOM signature
Sanitization list: cookies, tokens, request IDs, session IDs, personal data
Fixture provenance: route, dates, capture time, response kind
```

Expected: 모든 항목이 findings의 실제 문장·캡처 근거로 채워진다. 하나라도 없거나 `G1 result`가 PASS가 아니면 Google은 `BLOCKED`.

- [ ] **Step 2: Verify Naver findings completeness**

`docs/spikes/2026-07-14-naver-findings.md`에서 아래 항목을 직접 확인한다.

```text
G2 result: PASS
Consecutive successes: 3
Final case: exact origin, destination, departureDate, returnDate, tripDays
Acquisition mode: http | playwright
Selected mode: http | playwright
Direct-only evidence: request/filter value plus returned itinerary stop-count evidence
Response identity: HTTP method + endpoint + response content type, or navigation URL + ready condition + response/DOM selector
Price evidence: exact response JSON path or DOM selector and integer KRW normalization rule
Currency evidence: exact path/selector and observed KRW marker
URL evidence: exact path/selector or evidenced deterministic construction rule
Airline evidence: exact optional path/selector or explicit unavailable finding
Blocked evidence: observed status/body/DOM signature
Sanitization list: cookies, tokens, request IDs, session IDs, personal data
Fixture provenance: route, dates, capture time, response kind
```

Expected: 모든 항목이 findings의 실제 근거로 채워지고 G2가 3회 연속 성공이다. 하나라도 없으면 Naver는 `BLOCKED`.

- [ ] **Step 3: Select exactly one client per source**

다음 결정표를 그대로 적용한다.

```text
selected_mode=http
  → source의 src/providers/google/client.ts 또는 src/providers/naver/client.ts = native fetch client
  → fixtures = *.json
  → Playwright import, browser launch, selector code 금지

selected_mode=playwright
  → source의 src/providers/google/client.ts 또는 src/providers/naver/client.ts = browser client
  → fixtures = *.html, 또는 findings가 DOM이 아닌 browser network JSON 추출을 확정한 경우 *.json
  → mandatory injected browser/page factory
  → production factory rejects VITEST/CI and missing live opt-in
  → endpoint 재현 fetch code 금지

selected_mode 없음/혼재/증거 불일치
  → BLOCKED, source 파일 생성 금지
```

Expected: source마다 `http` 또는 `playwright` 하나가 결정되고 선택 근거가 findings의 절·문장으로 추적 가능하다.

- [ ] **Step 4: Verify immutable shared contract**

Run: `npm run typecheck`

Expected: exit code 0. `Quote`, `ProviderSearchInput`, `FlightProvider`가 이 문서의 Contract와 다르면 구현하지 않고 정확한 차이를 보고한다.

- [ ] **Step 5: Write source-specific implementation addenda**

Google은 `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase2-google-addendum.md`, Naver는 `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase2-naver-addendum.md`를 작성한다. 각 addendum에는 해당 findings에서 확정한 아래 내용을 실제 값과 완전한 코드로 기록한다.

```text
Status: Awaiting Approval
Findings source and exact section
final_case: origin, destination, departureDate, returnDate, tripDays
selected_mode: http or playwright
fixture response kind: JSON, browser network JSON, or stabilized HTML
exact request builder or exact browser action sequence
exact endpoint/method/encoding/headers or navigation/selectors/ready condition
exact itinerary, direct-stop, total-price, currency, URL, optional-airline extraction
exact blocked signature
complete client implementation
complete parser implementation
complete selected-mode client contract test
complete parser fixture inspector used only by tests
Playwright mode: mandatory browser/page factory interface and injection
Playwright mode: production factory guard code and guard tests
HTTP mode: global fetch replacement test with fake only
default npm test: browser launch count 0 and live network count 0 assertion
sanitization review
```

addendum는 이 문서의 scaffold와 invariants를 좁혀야 하며 shared types 또는 다른 source write set을 변경해서는 안 된다. exact value나 complete source-specific body가 하나라도 없으면 구현을 진행하지 않고 `BLOCKED`를 보고한다.

- [ ] **Step 6: STOP for addendum approval**

각 addendum를 사용자 또는 지정 reviewer가 검토한 뒤 첫 줄을 `Status: Approved`로 변경해야 한다. 승인에는 findings의 `final_case`, selected mode, exact endpoint/path/selector, complete client/parser/test code가 서로 일치한다는 확인이 포함된다. Playwright mode addendum는 mandatory factory seam과 production guard를, HTTP mode addendum는 fake global fetch test를 빠뜨리면 승인할 수 없다.

Expected: 승인된 source addendum만 다음 implementation task로 진행한다. `Status: Approved`가 아닌 source는 STOP 상태이며 fixture capture, parser/client/provider 구현, commit을 시작하지 않는다.

- [ ] **Step 7: Commit approved addenda independently**

Google addendum가 승인됐을 때:

```bash
git add docs/superpowers/plans/2026-07-14-flexible-flight-search-phase2-google-addendum.md
git commit -m "docs: approve Google provider implementation details"
```

Naver addendum가 승인됐을 때:

```bash
git add docs/superpowers/plans/2026-07-14-flexible-flight-search-phase2-naver-addendum.md
git commit -m "docs: approve Naver provider implementation details"
```

Expected: 승인된 addendum만 commit되고, 승인되지 않은 source는 implementation commit이 0개다.

## Task G1: Record and sanitize Google fixtures

**Precondition:** `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase2-google-addendum.md` 첫 줄이 `Status: Approved`다.

**Files:**
- Create: `tests/providers/google/fixtures/manifest.json`
- Create: `tests/providers/google/fixtures/direct-round-trip.json` or `.html`
- Create: `tests/providers/google/fixtures/synthetic-multiple-direct.json` or `.html`
- Create: `tests/providers/google/fixtures/synthetic-without-airline.json` or `.html`
- Create: `tests/providers/google/fixtures/no-direct-flight.json` or `.html`
- Create: `tests/providers/google/fixtures/malformed-response.json` or `.html`
- Create: `tests/providers/google/fixture-schema.test.ts`

- [ ] **Step 1: Record the Phase 0 final_case response as provenance**

승인된 Google addendum의 `final_case`를 그대로 사용해 `direct-round-trip`을 캡처한다. 실제 응답에 직항 후보가 하나뿐이거나 airline이 항상 있어도 정상이며 blocker가 아니다.

```text
Remove entirely: Cookie, Set-Cookie, Authorization, browser storage, analytics payload
Replace with "SANITIZED": CSRF token, session ID, request ID, trace ID, experiment ID
Retain: itinerary structure, stop counts, total prices, KRW marker, optional airline, public result URL
```

Expected: fixture의 route/date가 Google findings `final_case`와 일치하고, 실제 캡처 내용을 sanitization한 것 외에는 후보·가격·airline을 추가하거나 제거하지 않는다.

- [ ] **Step 2: Create explicitly synthetic algorithm fixtures**

`synthetic-multiple-direct`는 recorded fixture와 schema가 같은 sanitized synthetic fixture다. 기존 직항 후보를 보존하고 두 번째 직항 후보를 추가해 서로 다른 양의 KRW 정수 가격 두 개를 갖게 한다. URL은 RFC 2606 reserved host인 `https://example.test/` 아래 값을 사용하고 airline은 `"SYNTHETIC_AIRLINE"`처럼 synthetic임이 명확한 값만 사용한다.

`synthetic-without-airline`은 recorded fixture schema를 보존하되 synthetic 후보의 optional airline field만 생략한다. `no-direct-flight`는 실제 no-direct 캡처가 있으면 recorded, 없으면 경유 후보만 남기거나 결과 collection을 비운 schema-preserving synthetic fixture로 만든다. `malformed-response`는 required top-level node 하나를 제거한 synthetic fixture다.

Expected: synthetic 값은 live 관찰값으로 주장하지 않으며 manifest가 각 파일의 provenance와 목적을 구분한다.

- [ ] **Step 3: Write the final_case-driven manifest**

`tests/providers/google/fixtures/manifest.json`은 승인 addendum의 실제 `final_case`를 `request`에 기록하고 아래 schema를 만족한다.

```ts
interface GoogleFixtureManifest {
  schemaVersion: 2;
  source: "google";
  finalCaseSource:
    "docs/spikes/2026-07-14-google-findings.md#final_case";
  request: ProviderSearchInput & {
    roundTrip: true;
    adults: 1;
    cabin: "economy";
    directOnly: true;
  };
  fixtures: {
    provenanceDirectRoundTrip: {
      file: string;
      provenance: "recorded";
      finalCase: true;
    };
    syntheticMultipleDirect: {
      file: string;
      provenance: "synthetic";
      purpose: "min_selection";
    };
    syntheticWithoutAirline: {
      file: string;
      provenance: "synthetic";
      purpose: "optional_airline";
    };
    noDirectFlight: {
      file: string;
      provenance: "recorded" | "synthetic";
      purpose: "no_direct_flight";
    };
    malformedResponse: {
      file: string;
      provenance: "synthetic";
      purpose: "malformed_response";
    };
  };
  sanitized: true;
}
```

Google addendum가 승인되기 전에는 실제 `request` 값이나 fixture filename을 작성하지 않는다. 승인 후 recorded와 synthetic response 파일은 selected parser input에 맞춰 모두 `.json` 또는 모두 `.html`을 사용한다.

- [ ] **Step 4: Write the failing fixture schema assertion**

`tests/providers/google/fixture-schema.test.ts`는 manifest를 읽어 다음을 검증한다.

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ProviderSearchInput } from "../../../src/providers/types.js";

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);

describe("google fixture schema", () => {
  it("links the request to Google final_case", async () => {
    const manifest = JSON.parse(
      await readFile(fixtureUrl("manifest.json"), "utf8"),
    ) as {
      schemaVersion: number;
      source: string;
      finalCaseSource: string;
      request: ProviderSearchInput & Record<string, unknown>;
      sanitized: boolean;
    };

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      source: "google",
      finalCaseSource:
        "docs/spikes/2026-07-14-google-findings.md#final_case",
      request: {
        roundTrip: true,
        adults: 1,
        cabin: "economy",
        directOnly: true,
      },
      sanitized: true,
    });
    expect(manifest.request.origin).toMatch(/^[A-Z]{3}$/);
    expect(manifest.request.destination).toMatch(/^[A-Z]{3}$/);
    expect(manifest.request.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.request.returnDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.request.tripDays).toBeGreaterThanOrEqual(2);
  });

  it("separates recorded provenance from synthetic edge fixtures", async () => {
    const manifest = JSON.parse(
      await readFile(fixtureUrl("manifest.json"), "utf8"),
    ) as {
      fixtures: Record<
        string,
        { file: string; provenance: string } & Record<string, unknown>
      >;
    };
    expect(manifest.fixtures.provenanceDirectRoundTrip).toMatchObject({
      provenance: "recorded",
      finalCase: true,
    });
    expect(manifest.fixtures.syntheticMultipleDirect).toMatchObject({
      provenance: "synthetic",
      purpose: "min_selection",
    });
    expect(manifest.fixtures.syntheticWithoutAirline).toMatchObject({
      provenance: "synthetic",
      purpose: "optional_airline",
    });

    const bodies = await Promise.all(
      Object.values(manifest.fixtures).map(({ file }) =>
        readFile(fixtureUrl(file), "utf8"),
      ),
    );
    const captured = bodies.join("\n");

    expect(bodies.every((body) => body.length > 0)).toBe(true);
    expect(captured).not.toMatch(
      /(?:authorization|set-cookie|csrf|session[_-]?id|access[_-]?token)\s*[:=]\s*(?!["']?SANITIZED)/i,
    );
  });
});
```

- [ ] **Step 5: Run the fixture schema test**

Run: `npm test -- tests/providers/google/fixture-schema.test.ts`

Expected: `2 passed`; no network request occurs.

- [ ] **Step 6: Commit the fixtures**

```bash
git add tests/providers/google/fixtures tests/providers/google/fixture-schema.test.ts
git commit -m "test: record sanitized Google flight fixtures"
```

## Task G2: Implement the Google parser fixture-first

**Precondition:** 승인된 Google addendum에 complete parser body와 complete test-only fixture inspector가 있다. 아래 공개 scaffold만으로 구현 완료를 주장하지 않는다.

**Files:**
- Create: `src/providers/google/parser.ts`
- Create: `tests/providers/google/parser.contract.test.ts`

- [ ] **Step 1: Write parser contract tests before parser code**

`tests/providers/google/parser.contract.test.ts`는 fixture loader와 고정 시각을 사용한다.

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseGoogleDirectRoundTrip,
  GoogleParseFailure,
} from "../../../src/providers/google/parser.js";

interface GoogleFixtureManifest {
  fixtures: Record<string, { file: string }>;
}

const scrapedAt = "2026-07-14T00:00:00.000Z";
const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);
const manifest = JSON.parse(
  await readFile(fixtureUrl("manifest.json"), "utf8"),
) as GoogleFixtureManifest;
const fixture = (key: string) =>
  readFile(fixtureUrl(manifest.fixtures[key]!.file), "utf8");

describe("parseGoogleDirectRoundTrip", () => {
  it("parses the recorded final_case provenance fixture", async () => {
    const body = await fixture("provenanceDirectRoundTrip");
    const quote = parseGoogleDirectRoundTrip(body, scrapedAt);

    expect(quote.currency).toBe("KRW");
    expect(quote.price).toBeGreaterThan(0);
    expect(Number.isSafeInteger(quote.price)).toBe(true);
    expect(new URL(quote.url).protocol).toMatch(/^https?:$/);
    expect(quote.scrapedAt).toBe(scrapedAt);
    expect(Object.keys(quote).every((key) =>
      ["price", "currency", "url", "airline", "scrapedAt"].includes(key),
    )).toBe(true);
  });

  it("selects the minimum from synthetic direct candidates", async () => {
    const body = await fixture("syntheticMultipleDirect");
    const evidence = inspectGoogleFixture(body);
    const quote = parseGoogleDirectRoundTrip(body, scrapedAt);

    expect(evidence.directRoundTrips.length).toBeGreaterThanOrEqual(2);
    expect(evidence.directRoundTrips.every((item) => item.stopCount === 0)).toBe(true);
    expect(quote.price).toBe(
      Math.min(...evidence.directRoundTrips.map((item) => item.price)),
    );
  });

  it("omits airline for the synthetic optional-airline edge", async () => {
    const body = await fixture("syntheticWithoutAirline");
    const quote = parseGoogleDirectRoundTrip(body, scrapedAt);

    expect("airline" in quote).toBe(false);
  });

  it("rejects a normal response with no direct flight", async () => {
    const body = await fixture("noDirectFlight");

    expect(() => parseGoogleDirectRoundTrip(body, scrapedAt)).toThrowError(
      expect.objectContaining<Partial<GoogleParseFailure>>({
        code: "no_direct_flight",
      }),
    );
  });

  it("rejects malformed source responses", async () => {
    const body = await fixture("malformedResponse");

    expect(() => parseGoogleDirectRoundTrip(body, scrapedAt)).toThrowError(
      expect.objectContaining<Partial<GoogleParseFailure>>({
        code: "provider_error",
      }),
    );
  });

  it("rejects a non-ISO scrapedAt value", async () => {
    const body = await fixture("provenanceDirectRoundTrip");

    expect(() =>
      parseGoogleDirectRoundTrip(body, "2026-07-14"),
    ).toThrowError(
      expect.objectContaining<Partial<GoogleParseFailure>>({
        code: "provider_error",
      }),
    );
  });
});
```

`inspectGoogleFixture`의 complete test-only body는 승인된 Google addendum가 findings의 exact stop-count/price path 또는 selector로 정의한다. production parser와 코드를 공유하지 않고 `{ directRoundTrips: Array<{ stopCount: number; price: number }> }`를 반환한다. addendum 승인 전에는 이 test file을 작성하지 않는다.

Expected RED: parser module이 없어서 test suite가 fail한다.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/providers/google/parser.contract.test.ts`

Expected: FAIL with `Cannot find module '../../../src/providers/google/parser.js'`.

- [ ] **Step 3: Implement the parser against exact findings paths**

`src/providers/google/parser.ts`의 공개 표면은 다음과 같이 고정한다. Source-specific extraction은 findings가 아직 없으므로 이 계획에 가짜 구현을 싣지 않는다. 구현 시 아래 검증 순서를 모두 코드로 작성하며, findings의 exact path/selector를 옮길 수 없으면 이 step을 `BLOCKED`로 종료한다.

```ts
import type { Quote } from "../types.js";

export class GoogleParseFailure extends Error {
  constructor(
    readonly code: "no_direct_flight" | "provider_error",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GoogleParseFailure";
  }
}

export function parseGoogleDirectRoundTrip(
  body: string,
  scrapedAt: string,
): Quote;
```

함수 본문은 다음 순서로 작성한다.

1. selected mode에 맞게 JSON decode 또는 HTML parse.
2. findings의 왕복 itinerary collection path만 읽기.
3. outbound와 inbound 모두 findings의 `stopCount === 0` 증거를 만족하는 후보만 남기기.
4. currency marker가 정확히 KRW인 후보만 남기되, 비-KRW만 존재하면 `provider_error`.
5. 쉼표·원화 기호 제거 규칙이 findings에 관찰된 경우에만 적용하고 양의 안전 정수 검증.
6. 최저 `price` 후보 선택.
7. URL과 `scrapedAt` 검증.
8. airline 문자열이 있을 때만 spread로 property 추가.

airline optional 반환은 다음 concrete shape를 사용한다.

```ts
return {
  price,
  currency: "KRW",
  url,
  scrapedAt,
  ...(airline === undefined ? {} : { airline }),
};
```

실제 extraction body에 findings에 없는 fallback path, selector 후보 배열, guessed field name을 추가하지 않는다.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/providers/google/parser.contract.test.ts`

Expected: `6 passed`; recorded provenance parsing, synthetic direct-only 최저가, synthetic optional airline, KRW, URL, `scrapedAt`, invalid `scrapedAt`, no-direct, malformed assertions가 모두 통과한다.

- [ ] **Step 5: Commit the parser**

```bash
git add src/providers/google/parser.ts tests/providers/google/parser.contract.test.ts tests/providers/google/fixtures
git commit -m "feat: parse Google direct round-trip fixtures"
```

## Task G3: Implement the selected Google client and provider

**Precondition:** 승인된 Google addendum에 selected-mode client와 acquisition contract test의 complete code가 있다.

**Files:**
- Create: `src/providers/google/client.ts`
- Create: `src/providers/google/provider.ts`
- Create: `tests/providers/google/client.contract.test.ts`
- Create: `tests/providers/google/provider.contract.test.ts`

- [ ] **Step 1: Write provider contract tests with a fake client**

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSearchInput } from "../../../src/providers/types.js";
import {
  GoogleFlightProvider,
  ProviderFailure,
} from "../../../src/providers/google/provider.js";
import type {
  CapturedResponse,
  SourceClient,
} from "../../../src/providers/google/client.js";

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);
const manifest = JSON.parse(
  await readFile(fixtureUrl("manifest.json"), "utf8"),
) as {
  request: ProviderSearchInput;
  fixtures: Record<string, { file: string }>;
};
const body = await readFile(
  fixtureUrl(manifest.fixtures.provenanceDirectRoundTrip!.file),
  "utf8",
);
const input = manifest.request;
const captured: CapturedResponse = {
  body,
  scrapedAt: "2026-07-14T00:00:00.000Z",
};

describe("GoogleFlightProvider", () => {
  it("implements FlightProvider and parses the client response", async () => {
    const client: SourceClient = { search: vi.fn().mockResolvedValue(captured) };
    const provider = new GoogleFlightProvider(client);

    await expect(provider.findDirectRoundTrip(input)).resolves.toMatchObject({
      price: expect.any(Number),
      currency: "KRW",
      url: expect.stringMatching(/^https?:\/\//),
      scrapedAt: captured.scrapedAt,
    });
    expect(provider.id).toBe("google");
    expect(client.search).toHaveBeenCalledWith(input);
  });

  it.each([
    ["provider_timeout", Object.assign(new Error("timed out"), { name: "AbortError" })],
    ["provider_blocked", new ProviderFailure("provider_blocked", "blocked")],
  ] as const)("classifies %s", async (code, failure) => {
    const client: SourceClient = { search: vi.fn().mockRejectedValue(failure) };
    const provider = new GoogleFlightProvider(client);

    await expect(provider.findDirectRoundTrip(input)).rejects.toMatchObject({ code });
  });

  it("classifies malformed responses", async () => {
    const malformedBody = await readFile(
      fixtureUrl(manifest.fixtures.malformedResponse!.file),
      "utf8",
    );
    const client: SourceClient = {
      search: vi.fn().mockResolvedValue({ ...captured, body: malformedBody }),
    };
    const provider = new GoogleFlightProvider(client);

    await expect(provider.findDirectRoundTrip(input)).rejects.toMatchObject({
      code: "provider_error",
    });
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/providers/google/provider.contract.test.ts`

Expected: FAIL because `client.ts` and `provider.ts` do not exist.

- [ ] **Step 3: Implement only the selected client**

`client.ts`에는 `CapturedResponse`, `SourceClient`, 그리고 selected mode 구현 class 하나만 export한다. 두 방식 모두 다음 불변식을 지킨다.

```ts
const scrapedAt = new Date().toISOString();
return { body, scrapedAt };
```

HTTP 선택:

- native `fetch`와 findings의 exact method/URL/encoding/header/direct-only parameter를 사용한다.
- caller의 `AbortSignal`을 그대로 전달한다.
- findings가 기록한 403/429 및 body 차단 signature를 `ProviderFailure("provider_blocked", ...)`로 바꾼다.
- `response.ok === false`의 나머지는 `provider_error`.
- Playwright import는 0개다.

Playwright 선택:

- browser/page factory interface를 `client.ts`에 정의하고 client constructor에서 필수로 주입받는다. client 내부에서 production factory를 직접 생성하지 않는다.
- fake factory와 production factory가 같은 interface를 구현하며, production factory만 Playwright launch를 소유한다.
- production factory는 `assertProductionBrowserAllowed()`를 통과한 뒤에만 browser/page를 만든다.
- findings의 exact navigation/filter/ready/extraction 절차만 사용한다.
- caller abort 시 page/context를 닫고 `AbortError`를 던진다.
- findings의 CAPTCHA/interstitial selector가 보이면 `provider_blocked`.
- 획득한 response JSON text 또는 stabilized HTML 하나만 반환한다.
- private endpoint를 직접 호출하는 `fetch`는 0개다.

- [ ] **Step 4: Add an offline contract test for the selected client**

`tests/providers/google/client.contract.test.ts`는 selected mode 하나만 대상으로 한다.

HTTP selected mode에서는 test 시작 전에 `globalThis.fetch`를 `vi.stubGlobal("fetch", fakeFetch)`로 대체하고 `afterEach(() => vi.unstubAllGlobals())`로 복원한다. fake가 findings의 exact method, URL, request encoding, direct-only, 왕복, 성인 1, economy 값과 caller `AbortSignal`을 받는지 검증한다. 429와 findings의 blocked body signature 각각이 `provider_blocked`, abort가 `AbortError`, malformed success body가 parser 단계의 `provider_error`가 되는지 fixture로 검증한다. 실제 global fetch를 참조하거나 live URL을 호출하는 test는 0개여야 한다.

Playwright selected mode에서는 source-local fake browser/page factory만 client constructor에 주입한다. fake의 launch/page/navigation 호출 spy로 findings의 exact navigation, filter action, ready condition, extraction action을 검증하고 CAPTCHA/interstitial fixture는 `provider_blocked`, abort는 `AbortError`, malformed extracted body는 `provider_error`로 검증한다.

동일 test file에 production factory guard cases를 추가한다.

```ts
it("rejects the actual Vitest environment", async () => {
  const launch = vi.fn();
  const factory = new ProductionGoogleBrowserFactory({ launch });

  await expect(factory.createPage()).rejects.toThrow(
    "production browser factory is disabled under VITEST or CI",
  );
  expect(launch).not.toHaveBeenCalled();
});

it.each(["VITEST", "CI"] as const)(
  "rejects production browser launch when %s is present",
  async (name) => {
    const launch = vi.fn();
    const env = { [name]: "1", SEARCH_WAY_ALLOW_LIVE_NETWORK: "1" };
    const factory = new ProductionGoogleBrowserFactory({ launch, env });

    await expect(factory.createPage()).rejects.toThrow(
      "production browser factory is disabled under VITEST or CI",
    );
    expect(launch).not.toHaveBeenCalled();
  },
);

it("requires explicit live opt-in outside test and CI", async () => {
  const launch = vi.fn();
  const factory = new ProductionGoogleBrowserFactory({ launch, env: {} });

  await expect(factory.createPage()).rejects.toThrow(
    "set SEARCH_WAY_ALLOW_LIVE_NETWORK=1 for manual live browser access",
  );
  expect(launch).not.toHaveBeenCalled();
});
```

`ProductionGoogleBrowserFactory`의 exact constructor와 page type은 승인된 Google addendum에서 complete code로 고정한다. 위 guard test 의미와 오류 문자열은 변경하지 않는다.

Run: `npm test -- tests/providers/google/client.contract.test.ts`

Expected: selected client contract cases pass; `browserLaunchCount === 0`, `liveNetworkCallCount === 0`; network와 실제 browser process를 사용하지 않는다.

- [ ] **Step 5: Implement provider composition**

`provider.ts`:

```ts
import type {
  FlightProvider,
  ProviderSearchInput,
  Quote,
} from "../types.js";
import type { SourceClient } from "./client.js";
import {
  GoogleParseFailure,
  parseGoogleDirectRoundTrip,
} from "./parser.js";

export type ProviderFailureCode =
  | "provider_timeout"
  | "provider_blocked"
  | "no_direct_flight"
  | "provider_error";

export class ProviderFailure extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderFailure";
  }
}

export class GoogleFlightProvider implements FlightProvider {
  readonly id = "google" as const;

  constructor(private readonly client: SourceClient) {}

  async findDirectRoundTrip(
    input: ProviderSearchInput,
  ): Promise<Quote> {
    try {
      const captured = await this.client.search(input);
      return parseGoogleDirectRoundTrip(captured.body, captured.scrapedAt);
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      if (error instanceof GoogleParseFailure) {
        throw new ProviderFailure(error.code, error.message, { cause: error });
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderFailure("provider_timeout", "Google request timed out", {
          cause: error,
        });
      }
      throw new ProviderFailure("provider_error", "Google provider failed", {
        cause: error,
      });
    }
  }
}
```

- [ ] **Step 6: Run Google GREEN and source verification**

Run:

```bash
npm test -- tests/providers/google
npm run typecheck
```

Expected: Google fixture/parser/provider tests all pass, typecheck exits 0, test process opens no network connection.

- [ ] **Step 7: Commit Google provider**

```bash
git add src/providers/google tests/providers/google
git commit -m "feat: add Google Flights provider adapter"
```

## Task N1: Record and sanitize Naver fixtures

**Precondition:** `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase2-naver-addendum.md` 첫 줄이 `Status: Approved`다.

**Files:**
- Create: `tests/providers/naver/fixtures/manifest.json`
- Create: `tests/providers/naver/fixtures/direct-round-trip.json` or `.html`
- Create: `tests/providers/naver/fixtures/synthetic-multiple-direct.json` or `.html`
- Create: `tests/providers/naver/fixtures/synthetic-without-airline.json` or `.html`
- Create: `tests/providers/naver/fixtures/no-direct-flight.json` or `.html`
- Create: `tests/providers/naver/fixtures/malformed-response.json` or `.html`
- Create: `tests/providers/naver/fixture-schema.test.ts`

- [ ] **Step 1: Capture Naver successful, no-direct, and malformed fixtures**

승인된 Naver addendum의 `final_case`와 exact request/filter를 사용해 `direct-round-trip`을 캡처한다. 실제 응답의 직항 후보 수와 airline 유무를 그대로 보존한다.

```text
Remove entirely:
- Cookie
- Set-Cookie
- Authorization
- browser local/session storage
- analytics payload

Replace with the literal string "SANITIZED":
- CSRF token
- session ID
- request ID
- trace ID
- experiment ID

Retain:
- outbound and inbound itinerary structure
- direct-flight stop-count evidence
- total KRW prices
- public search or booking URL
- airline only when the source exposes it
```

`synthetic-multiple-direct`는 recorded fixture와 schema가 같은 sanitized synthetic fixture다. 기존 직항 후보를 보존하고 서로 다른 양의 KRW 정수 가격을 가진 synthetic 직항 후보를 추가한다. synthetic URL은 `https://example.test/` 아래 값을, airline이 필요하면 `"SYNTHETIC_AIRLINE"`을 사용한다.

`synthetic-without-airline`은 schema-preserving synthetic 후보에서 optional airline field를 생략한다. `no-direct-flight`는 실제 캡처가 있으면 recorded, 없으면 경유 후보만 남기거나 result collection을 비운 synthetic fixture다. `malformed-response`는 required top-level node 하나를 제거한 synthetic fixture다.

Expected: recorded fixture는 Naver findings `final_case`의 provenance만 주장한다. synthetic fixtures는 알고리즘 edge만 검증하며 live 가격·URL·airline 관찰 증거로 보고하지 않는다.

- [ ] **Step 2: Write Naver manifest**

`tests/providers/naver/fixtures/manifest.json`은 승인 addendum의 실제 `final_case`를 `request`에 기록하고 아래 schema를 만족한다.

```ts
interface NaverFixtureManifest {
  schemaVersion: 2;
  source: "naver";
  finalCaseSource:
    "docs/spikes/2026-07-14-naver-findings.md#final_case";
  request: ProviderSearchInput & {
    roundTrip: true;
    adults: 1;
    cabin: "economy";
    directOnly: true;
  };
  fixtures: {
    provenanceDirectRoundTrip: {
      file: string;
      provenance: "recorded";
      finalCase: true;
    };
    syntheticMultipleDirect: {
      file: string;
      provenance: "synthetic";
      purpose: "min_selection";
    };
    syntheticWithoutAirline: {
      file: string;
      provenance: "synthetic";
      purpose: "optional_airline";
    };
    noDirectFlight: {
      file: string;
      provenance: "recorded" | "synthetic";
      purpose: "no_direct_flight";
    };
    malformedResponse: {
      file: string;
      provenance: "synthetic";
      purpose: "malformed_response";
    };
  };
  sanitized: true;
}
```

Naver addendum가 승인되기 전에는 실제 `request` 값이나 filename을 작성하지 않는다. 승인 후 response fixture는 selected parser input에 맞춰 모두 `.json` 또는 모두 `.html`을 사용한다.

- [ ] **Step 3: Write Naver fixture schema test**

Create `tests/providers/naver/fixture-schema.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ProviderSearchInput } from "../../../src/providers/types.js";

interface NaverFixtureManifest {
  schemaVersion: number;
  source: string;
  finalCaseSource: string;
  request: ProviderSearchInput & Record<string, unknown>;
  fixtures: Record<
    string,
    { file: string; provenance: string } & Record<string, unknown>
  >;
  sanitized: boolean;
}

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);

async function readManifest(): Promise<NaverFixtureManifest> {
  return JSON.parse(
    await readFile(fixtureUrl("manifest.json"), "utf8"),
  ) as NaverFixtureManifest;
}

describe("naver fixture schema", () => {
  it("records a sanitized direct-only round-trip request", async () => {
    const manifest = await readManifest();

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      source: "naver",
      finalCaseSource:
        "docs/spikes/2026-07-14-naver-findings.md#final_case",
      request: {
        roundTrip: true,
        adults: 1,
        cabin: "economy",
        directOnly: true,
      },
      fixtures: {
        provenanceDirectRoundTrip: {
          provenance: "recorded",
          finalCase: true,
        },
        syntheticMultipleDirect: {
          provenance: "synthetic",
          purpose: "min_selection",
        },
        syntheticWithoutAirline: {
          provenance: "synthetic",
          purpose: "optional_airline",
        },
      },
      sanitized: true,
    });

    expect(manifest.request.origin).toMatch(/^[A-Z]{3}$/);
    expect(manifest.request.destination).toMatch(/^[A-Z]{3}$/);
    expect(manifest.request.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.request.returnDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.request.tripDays).toBeGreaterThanOrEqual(2);
    const extensions = Object.values(manifest.fixtures).map(({ file }) =>
      file.split(".").at(-1),
    );
    expect(new Set(extensions).size).toBe(1);
  });

  it("contains every declared fixture and no captured secrets", async () => {
    const manifest = await readManifest();
    const bodies = await Promise.all(
      Object.values(manifest.fixtures).map(({ file }) =>
        readFile(fixtureUrl(file), "utf8"),
      ),
    );
    const captured = bodies.join("\n");

    expect(bodies.every((body) => body.length > 0)).toBe(true);
    expect(captured).not.toMatch(
      /(?:authorization|set-cookie|csrf|session[_-]?id|access[_-]?token)\s*[:=]\s*(?!["']?SANITIZED)/i,
    );
  });
});
```

- [ ] **Step 4: Run the Naver fixture schema test**

Run: `npm test -- tests/providers/naver/fixture-schema.test.ts`

Expected: `2 passed`; recorded provenance와 synthetic fixture 분류가 명확하고 no network request occurs.

- [ ] **Step 5: Commit Naver fixtures**

```bash
git add tests/providers/naver/fixtures tests/providers/naver/fixture-schema.test.ts
git commit -m "test: record sanitized Naver flight fixtures"
```

## Task N2: Implement the Naver parser fixture-first

**Precondition:** 승인된 Naver addendum에 complete parser body와 complete test-only fixture inspector가 있다. 아래 공개 scaffold만으로 구현 완료를 주장하지 않는다.

**Files:**
- Create: `src/providers/naver/parser.ts`
- Create: `tests/providers/naver/parser.contract.test.ts`

- [ ] **Step 1: Write the Naver parser contract tests**

승인된 Naver addendum의 complete test-only inspector와 manifest-driven fixture loader를 사용해 아래 test를 작성한다. 실제 recorded fixture의 후보 수나 airline 유무는 test 선행 조건이 아니다.

Create `tests/providers/naver/parser.contract.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  NaverParseFailure,
  parseNaverDirectRoundTrip,
} from "../../../src/providers/naver/parser.js";

interface NaverFixtureManifest {
  fixtures: Record<string, { file: string }>;
}

const scrapedAt = "2026-07-14T00:00:00.000Z";
const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);

async function readManifest(): Promise<NaverFixtureManifest> {
  return JSON.parse(
    await readFile(fixtureUrl("manifest.json"), "utf8"),
  ) as NaverFixtureManifest;
}

async function fixture(
  key: string,
): Promise<string> {
  const manifest = await readManifest();
  return readFile(fixtureUrl(manifest.fixtures[key]!.file), "utf8");
}

describe("parseNaverDirectRoundTrip", () => {
  it("parses the recorded final_case provenance fixture", async () => {
    const body = await fixture("provenanceDirectRoundTrip");
    const quote = parseNaverDirectRoundTrip(body, scrapedAt);

    expect(quote.currency).toBe("KRW");
    expect(Number.isSafeInteger(quote.price)).toBe(true);
    expect(quote.price).toBeGreaterThan(0);
    expect(new URL(quote.url).protocol).toMatch(/^https?:$/);
    expect(quote.scrapedAt).toBe(scrapedAt);
    expect(Object.keys(quote).every((key) =>
      ["price", "currency", "url", "airline", "scrapedAt"].includes(key),
    )).toBe(true);
  });

  it("selects the minimum from synthetic direct candidates", async () => {
    const body = await fixture("syntheticMultipleDirect");
    const evidence = inspectNaverFixture(body);
    const quote = parseNaverDirectRoundTrip(body, scrapedAt);

    expect(evidence.directRoundTrips.length).toBeGreaterThanOrEqual(2);
    expect(evidence.directRoundTrips.every((item) => item.stopCount === 0)).toBe(true);
    expect(quote.price).toBe(
      Math.min(...evidence.directRoundTrips.map((item) => item.price)),
    );
  });

  it("omits airline for the synthetic optional-airline edge", async () => {
    const body = await fixture("syntheticWithoutAirline");
    const quote = parseNaverDirectRoundTrip(body, scrapedAt);

    expect("airline" in quote).toBe(false);
  });

  it("rejects a normal response with no direct flight", async () => {
    const body = await fixture("noDirectFlight");

    expect(() => parseNaverDirectRoundTrip(body, scrapedAt)).toThrowError(
      expect.objectContaining<Partial<NaverParseFailure>>({
        code: "no_direct_flight",
      }),
    );
  });

  it("rejects malformed source responses", async () => {
    const body = await fixture("malformedResponse");

    expect(() => parseNaverDirectRoundTrip(body, scrapedAt)).toThrowError(
      expect.objectContaining<Partial<NaverParseFailure>>({
        code: "provider_error",
      }),
    );
  });

  it("rejects a non-ISO scrapedAt value", async () => {
    const body = await fixture("provenanceDirectRoundTrip");

    expect(() =>
      parseNaverDirectRoundTrip(body, "2026-07-14"),
    ).toThrowError(
      expect.objectContaining<Partial<NaverParseFailure>>({
        code: "provider_error",
      }),
    );
  });
});
```

`inspectNaverFixture`의 complete test-only body는 승인된 Naver addendum가 exact stop-count/price path 또는 selector로 정의한다. production parser와 코드를 공유하지 않는다.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/providers/naver/parser.contract.test.ts`

Expected: FAIL with missing `src/providers/naver/parser.js`.

- [ ] **Step 3: Implement the Naver parser**

`src/providers/naver/parser.ts`의 공개 표면은 아래와 같다. Source-specific extraction은 findings의 확정값 없이는 작성하지 않고 `BLOCKED`로 처리한다.

```ts
import type { Quote } from "../types.js";

export class NaverParseFailure extends Error {
  constructor(
    readonly code: "no_direct_flight" | "provider_error",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NaverParseFailure";
  }
}

export function parseNaverDirectRoundTrip(
  body: string,
  scrapedAt: string,
): Quote;
```

함수 본문은 다음 순서로 작성한다.

1. `scrapedAt`이 canonical ISO-8601인지 검사하고 아니면 `NaverParseFailure("provider_error", ...)`를 던진다.
2. selected mode의 parser 입력에 맞춰 JSON decode 또는 HTML parse를 한 번만 수행한다.
3. Naver findings가 확정한 itinerary collection path 또는 selector 하나만 읽는다.
4. outbound와 inbound의 stop count가 모두 0인 왕복 후보만 남긴다.
5. 정상 응답이지만 직항 왕복 후보가 없으면 `NaverParseFailure("no_direct_flight", ...)`를 던진다.
6. currency marker가 정확히 KRW인 후보만 허용하고, 비-KRW 후보만 있으면 `provider_error`를 던진다.
7. findings에 기록된 구분자와 원화 기호만 제거한 뒤 양의 safe integer인지 검사한다.
8. 직항 후보의 `price` 최솟값을 선택한다.
9. URL이 `http:` 또는 `https:`인지 검사한다.
10. airline이 non-empty string일 때만 property를 포함한다.

반환 shape:

```ts
return {
  price,
  currency: "KRW",
  url,
  scrapedAt,
  ...(airline === undefined ? {} : { airline }),
};
```

Naver findings에 없는 fallback path, selector 후보 배열, Google parser import를 추가하지 않는다.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/providers/naver/parser.contract.test.ts`

Expected: `6 passed`; recorded provenance parsing, synthetic min-selection, synthetic optional-airline, invalid `scrapedAt`, no-direct, malformed cases가 통과한다.

- [ ] **Step 5: Commit Naver parser**

```bash
git add src/providers/naver/parser.ts tests/providers/naver/parser.contract.test.ts tests/providers/naver/fixtures
git commit -m "feat: parse Naver direct round-trip fixtures"
```

## Task N3: Implement the selected Naver client and provider

**Precondition:** 승인된 Naver addendum에 selected-mode client와 acquisition contract test의 complete code가 있다.

**Files:**
- Create: `src/providers/naver/client.ts`
- Create: `src/providers/naver/provider.ts`
- Create: `tests/providers/naver/client.contract.test.ts`
- Create: `tests/providers/naver/provider.contract.test.ts`

- [ ] **Step 1: Write Naver provider contract tests**

Create `tests/providers/naver/provider.contract.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  CapturedResponse,
  SourceClient,
} from "../../../src/providers/naver/client.js";
import type { ProviderSearchInput } from "../../../src/providers/types.js";
import { NaverClientFailure } from "../../../src/providers/naver/client.js";
import {
  NaverFlightProvider,
} from "../../../src/providers/naver/provider.js";

interface NaverFixtureManifest {
  request: ProviderSearchInput;
  fixtures: Record<string, { file: string }>;
}

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);
const manifest = JSON.parse(
  await readFile(fixtureUrl("manifest.json"), "utf8"),
) as NaverFixtureManifest;
const body = await readFile(
  fixtureUrl(manifest.fixtures.provenanceDirectRoundTrip!.file),
  "utf8",
);
const malformedBody = await readFile(
  fixtureUrl(manifest.fixtures.malformedResponse!.file),
  "utf8",
);
const input = manifest.request;
const captured: CapturedResponse = {
  body,
  scrapedAt: "2026-07-14T00:00:00.000Z",
};

describe("NaverFlightProvider", () => {
  it("implements FlightProvider and parses the client response", async () => {
    const client: SourceClient = { search: vi.fn().mockResolvedValue(captured) };
    const provider = new NaverFlightProvider(client);

    await expect(provider.findDirectRoundTrip(input)).resolves.toMatchObject({
      price: expect.any(Number),
      currency: "KRW",
      url: expect.stringMatching(/^https?:\/\//),
      scrapedAt: captured.scrapedAt,
    });
    expect(provider.id).toBe("naver");
    expect(client.search).toHaveBeenCalledWith(input);
  });

  it("classifies an aborted acquisition as provider_timeout", async () => {
    const aborted = Object.assign(new Error("timed out"), {
      name: "AbortError",
    });
    const client: SourceClient = { search: vi.fn().mockRejectedValue(aborted) };
    const provider = new NaverFlightProvider(client);

    await expect(provider.findDirectRoundTrip(input)).rejects.toMatchObject({
      code: "provider_timeout",
    });
  });

  it("maps client blocking to provider_blocked", async () => {
    const blocked = new NaverClientFailure(
      "provider_blocked",
      "Naver blocked",
    );
    const client: SourceClient = { search: vi.fn().mockRejectedValue(blocked) };
    const provider = new NaverFlightProvider(client);

    await expect(provider.findDirectRoundTrip(input)).rejects.toMatchObject({
      code: "provider_blocked",
    });
  });

  it("classifies malformed responses as provider_error", async () => {
    const client: SourceClient = {
      search: vi.fn().mockResolvedValue({ ...captured, body: malformedBody }),
    };
    const provider = new NaverFlightProvider(client);

    await expect(provider.findDirectRoundTrip(input)).rejects.toMatchObject({
      code: "provider_error",
    });
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/providers/naver/provider.contract.test.ts`

Expected: FAIL because Naver `client.ts` and `provider.ts` do not exist.

- [ ] **Step 3: Implement only the selected Naver client**

`src/providers/naver/client.ts`에 아래 공개 계약을 정의한다.

```ts
import type { ProviderSearchInput } from "../types.js";

export type NaverClientFailureCode =
  | "provider_blocked"
  | "provider_error";

export class NaverClientFailure extends Error {
  constructor(
    readonly code: NaverClientFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NaverClientFailure";
  }
}

export interface CapturedResponse {
  body: string;
  scrapedAt: string;
}

export interface SourceClient {
  search(
    input: ProviderSearchInput,
    signal?: AbortSignal,
  ): Promise<CapturedResponse>;
}

export type NaverAcquire = (
  input: ProviderSearchInput,
  signal?: AbortSignal,
) => Promise<string>;

export class NaverClient implements SourceClient {
  constructor(
    private readonly acquire: NaverAcquire,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async search(
    input: ProviderSearchInput,
    signal?: AbortSignal,
  ): Promise<CapturedResponse> {
    const body = await this.acquire(input, signal);
    return {
      body,
      scrapedAt: this.now().toISOString(),
    };
  }
}
```

위 `NaverAcquire` seam은 HTTP selected mode 또는 mode-neutral fixture test용이다. Playwright selected mode production client는 이를 browser factory의 대체물로 사용하지 않는다. 승인 addendum는 아래 generic factory contract를 findings에 맞는 concrete page type으로 좁히고, browser client constructor에 non-optional factory를 직접 받는 complete code를 제공한다.

```ts
export interface BrowserPageFactory<TPage> {
  createPage(): Promise<TPage>;
}

export abstract class NaverBrowserClient<TPage>
  implements SourceClient {
  constructor(
    protected readonly pageFactory: BrowserPageFactory<TPage>,
  ) {}

  abstract search(
    input: ProviderSearchInput,
    signal?: AbortSignal,
  ): Promise<CapturedResponse>;
}
```

`NaverBrowserClient`의 production subclass는 `ProductionNaverBrowserFactory`를 내부 생성할 수 없고 constructor injection만 허용한다.

findings의 `selected_mode`가 `http`이면 native `fetch` class 하나만 구현한다.

1. findings의 exact method, endpoint, request encoding, headers를 사용한다.
2. `origin`, `destination`, `departureDate`, `returnDate`, 성인 1, economy, 왕복, direct-only를 findings의 exact parameter names로 매핑한다.
3. caller `AbortSignal`을 `fetch`에 전달한다.
4. findings에 기록된 403/429 및 blocked body signature를 `NaverClientFailure("provider_blocked", ...)`로 바꾼다.
5. 그 외 non-2xx는 `NaverClientFailure("provider_error", ...)`로 바꾼다.
6. response body를 문자열로 한 번만 읽고 acquisition 직후 `new Date().toISOString()`을 기록한다.
7. Playwright import와 browser fallback을 추가하지 않는다.

findings의 `selected_mode`가 `playwright`이면 browser client class 하나만 구현한다.

1. browser/page factory interface를 정의하고 browser client constructor의 필수 argument로 받는다.
2. browser client는 constructor 또는 method 안에서 production factory를 직접 생성하지 않는다.
3. production factory의 `createPage()`는 첫 줄에서 `assertProductionBrowserAllowed()`를 호출한다.
4. findings의 exact navigation URL과 input mapping을 사용한다.
5. findings의 exact direct-only 설정 action과 ready condition을 수행한다.
6. findings가 확정한 network response 또는 stabilized DOM 하나만 body로 추출한다.
7. findings의 CAPTCHA/interstitial selector가 나타나면 `NaverClientFailure("provider_blocked", ...)`를 던진다.
8. caller abort 시 page/context를 닫고 name이 `AbortError`인 오류를 던진다.
9. acquisition 직후 `new Date().toISOString()`을 기록한다.
10. private endpoint를 재현하는 fetch fallback을 추가하지 않는다.

`selected_mode`, exact endpoint/parameter, exact selector/ready condition 중 하나라도 findings에서 확정되지 않으면 client code를 작성하지 않고 `BLOCKED`다.

- [ ] **Step 4: Add an offline contract test for the selected Naver client**

Create `tests/providers/naver/client.contract.test.ts` after the mode gate:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSearchInput } from "../../../src/providers/types.js";
import {
  NaverClient,
  NaverClientFailure,
} from "../../../src/providers/naver/client.js";

const fixedNow = new Date("2026-07-14T00:00:00.000Z");
const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);
const manifest = JSON.parse(
  await readFile(fixtureUrl("manifest.json"), "utf8"),
) as {
  request: ProviderSearchInput;
  fixtures: Record<string, { file: string }>;
};
const input = manifest.request;
const successfulBody = await readFile(
  fixtureUrl(manifest.fixtures.provenanceDirectRoundTrip!.file),
  "utf8",
);

describe("Naver client contract", () => {
  it("returns body with a canonical acquisition timestamp", async () => {
    const acquire = vi.fn().mockResolvedValue(successfulBody);
    const client = new NaverClient(acquire, () => fixedNow);
    const result = await client.search(input);

    expect(result).toEqual({
      body: successfulBody,
      scrapedAt: "2026-07-14T00:00:00.000Z",
    });
    expect(acquire).toHaveBeenCalledWith(input, undefined);
  });

  it("classifies the evidenced blocked response", async () => {
    const blocked = new NaverClientFailure(
      "provider_blocked",
      "Naver blocked the acquisition",
    );
    const client = new NaverClient(vi.fn().mockRejectedValue(blocked));

    await expect(client.search(input)).rejects.toBe(blocked);
  });

  it("honors caller abort", async () => {
    const controller = new AbortController();
    const acquire = vi.fn(
      async (_input: ProviderSearchInput, signal?: AbortSignal) => {
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        return successfulBody;
      },
    );
    const client = new NaverClient(acquire);
    controller.abort();

    await expect(client.search(input, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(acquire).toHaveBeenCalledWith(input, controller.signal);
  });
});
```

HTTP selected mode에서는 이 파일에 실제 fetch acquisition contract suite를 추가한다. test 시작 전에 `globalThis.fetch`를 `vi.stubGlobal("fetch", fakeFetch)`로 교체하고 `afterEach(() => vi.unstubAllGlobals())`로 복원한다. exact method, URL, encoded body/query, headers, `signal`을 Naver findings 값과 문자 단위로 비교한다. successful response는 sanitized JSON fixture를 반환하고, findings가 확정한 403/429 또는 body signature가 `NaverClientFailure`의 `provider_blocked`로 분류되는지 검증한다. 실제 global fetch 또는 live URL 호출은 금지한다.

Playwright selected mode에서는 fake browser/page factory만 실제 browser client constructor에 주입한다. exact navigation, direct-only action, ready condition, extraction action 순서를 Naver findings 값과 비교한다. successful fake는 sanitized response/DOM fixture를 반환하고 findings의 CAPTCHA/interstitial selector가 `NaverClientFailure`의 `provider_blocked`로 분류되는지 검증한다.

동일 test file에 다음 production factory guard cases를 추가한다.

```ts
it("rejects the actual Vitest environment", async () => {
  const launch = vi.fn();
  const factory = new ProductionNaverBrowserFactory({ launch });

  await expect(factory.createPage()).rejects.toThrow(
    "production browser factory is disabled under VITEST or CI",
  );
  expect(launch).not.toHaveBeenCalled();
});

it.each(["VITEST", "CI"] as const)(
  "rejects production browser launch when %s is present",
  async (name) => {
    const launch = vi.fn();
    const env = { [name]: "1", SEARCH_WAY_ALLOW_LIVE_NETWORK: "1" };
    const factory = new ProductionNaverBrowserFactory({ launch, env });

    await expect(factory.createPage()).rejects.toThrow(
      "production browser factory is disabled under VITEST or CI",
    );
    expect(launch).not.toHaveBeenCalled();
  },
);

it("requires explicit live opt-in outside test and CI", async () => {
  const launch = vi.fn();
  const factory = new ProductionNaverBrowserFactory({ launch, env: {} });

  await expect(factory.createPage()).rejects.toThrow(
    "set SEARCH_WAY_ALLOW_LIVE_NETWORK=1 for manual live browser access",
  );
  expect(launch).not.toHaveBeenCalled();
});
```

`ProductionNaverBrowserFactory`의 exact constructor와 page type은 승인된 Naver addendum에서 complete code로 고정한다. 두 acquisition-mode suite를 한 파일에 함께 구현하지 않는다. 선택된 branch의 exact acquisition assertion만 추가한다. findings가 없어서 exact URL/selector/action assertion을 작성할 수 없으면 이 test file을 만들지 않고 `BLOCKED`를 유지한다.

Run: `npm test -- tests/providers/naver/client.contract.test.ts`

Expected: selected Naver client contract cases pass; `browserLaunchCount === 0`, `liveNetworkCallCount === 0`; live network와 실제 browser process를 사용하지 않는다.

- [ ] **Step 5: Implement Naver provider composition**

Create `src/providers/naver/provider.ts`:

```ts
import type {
  FlightProvider,
  ProviderSearchInput,
  Quote,
} from "../types.js";
import type { SourceClient } from "./client.js";
import { NaverClientFailure } from "./client.js";
import {
  NaverParseFailure,
  parseNaverDirectRoundTrip,
} from "./parser.js";

export type ProviderFailureCode =
  | "provider_timeout"
  | "provider_blocked"
  | "no_direct_flight"
  | "provider_error";

export class ProviderFailure extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderFailure";
  }
}

export class NaverFlightProvider implements FlightProvider {
  readonly id = "naver" as const;

  constructor(private readonly client: SourceClient) {}

  async findDirectRoundTrip(
    input: ProviderSearchInput,
  ): Promise<Quote> {
    try {
      const captured = await this.client.search(input);
      return parseNaverDirectRoundTrip(captured.body, captured.scrapedAt);
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      if (error instanceof NaverClientFailure) {
        throw new ProviderFailure(error.code, error.message, { cause: error });
      }
      if (error instanceof NaverParseFailure) {
        throw new ProviderFailure(error.code, error.message, { cause: error });
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderFailure("provider_timeout", "Naver request timed out", {
          cause: error,
        });
      }
      throw new ProviderFailure("provider_error", "Naver provider failed", {
        cause: error,
      });
    }
  }
}
```

- [ ] **Step 6: Run Naver GREEN and source verification**

Run:

```bash
npm test -- tests/providers/naver
npm run typecheck
```

Expected: Naver fixture/parser/provider tests all pass, typecheck exits 0, test process opens no network connection.

- [ ] **Step 7: Commit Naver provider**

```bash
git add src/providers/naver tests/providers/naver
git commit -m "feat: add Naver Flights provider adapter"
```

## Task 4: Integrate the two offline provider workstreams

**Files:**
- Modify: none
- Verify: all owned paths from Workstream G and Workstream N

- [ ] **Step 1: Check write-set isolation**

Run:

```bash
git diff --name-only -- src/providers tests/providers
```

Expected: changed files are contained only in `src/providers/google/**`, `tests/providers/google/**`, `src/providers/naver/**`, `tests/providers/naver/**`; no shared type or config file appears.

- [ ] **Step 2: Run the complete offline provider suite**

Run:

```bash
npm test -- tests/providers
npm run typecheck
npm run build
```

Expected: all commands exit 0. Tests read only committed sanitized fixtures; source client contract assertions report `browserLaunchCount === 0` and `liveNetworkCallCount === 0`; live HTTP, browser launch, browser navigation은 모두 0건이다.

- [ ] **Step 3: Verify acquisition mode fidelity**

For each source compare `client.ts` with its findings:

```text
HTTP selected:
- exact method/endpoint/request encoding/header/filter values match findings
- client.ts has no Playwright import
- fixture kind matches captured HTTP response

Playwright selected:
- exact navigation/filter/ready/extraction values match findings
- client.ts does not recreate a private endpoint with fetch
- fixture kind matches extracted response or stabilized DOM described by findings
```

Expected: source마다 하나의 selected mode만 구현되고 undocumented fallback, endpoint, selector가 0개다.

- [ ] **Step 4: Confirm Phase 2 exit gate**

Expected:

```text
PASS Google parser: lowest direct KRW quote from sanitized fixture
PASS Naver parser: lowest direct KRW quote from sanitized fixture
PASS recorded fixtures match each source findings final_case
PASS min-selection and optional-airline edges use manifest-labeled synthetic fixtures
PASS both source addenda are Status: Approved
PASS no direct flight: no_direct_flight for both sources
PASS timeout: provider_timeout for both sources
PASS blocked: provider_blocked for both sources
PASS malformed: provider_error for both sources
PASS airline optional, valid URL, ISO scrapedAt
PASS all CI/default tests offline
PASS adapter mode equals Phase 0 findings selected_mode
```

하나라도 실패하면 Phase 3로 진행하지 않는다.

- [ ] **Step 5: Commit integration-only fixes if required**

두 write set 안의 test/implementation 수정만 허용한다.

```bash
git add src/providers/google tests/providers/google src/providers/naver tests/providers/naver
git commit -m "test: verify offline provider contracts"
```

변경이 없으면 빈 commit을 만들지 않는다.

## Manual Live Smoke

CI, `npm test`, provider contract suite에는 live smoke를 등록하지 않는다. Phase 2 offline gate를 통과한 뒤 사람의 명시적 실행으로 source별 1회만 수행한다. Google smoke는 Google manifest의 `request`, Naver smoke는 Naver manifest의 `request`를 읽으므로 두 source의 `final_case`가 달라도 된다.

Playwright selected mode의 manual live command는 승인 addendum에 실제 script와 함께 기록하며 반드시 `SEARCH_WAY_ALLOW_LIVE_NETWORK=1` 환경에서만 실행한다. flag가 없거나 `process.env.VITEST`/`process.env.CI`가 존재하면 production browser factory가 launch 전에 명시적으로 실패해야 한다.

```text
Input:
  Google: read tests/providers/google/fixtures/manifest.json
  Naver: read tests/providers/naver/fixtures/manifest.json
  pass manifest.request without replacing route or dates

Assert:
  provider.id is expected source
  price is a positive safe integer
  currency is KRW
  URL is http/https and reproduces route/dates/round-trip/direct-only
  airline is absent or a non-empty string
  scrapedAt is current ISO-8601 UTC
```

라이브 결과는 recorded provenance 또는 synthetic fixture 가격과 같을 필요가 없다. CAPTCHA, 403/429, timeout은 분류 결과만 확인하고 CI 성공 조건으로 사용하지 않는다. smoke 중 새 endpoint/selector가 필요해지면 즉석 fallback을 추가하지 않고 findings와 source addendum를 갱신·재승인한 뒤 진행한다.

## Verification

source별 독립 명령:

```bash
npm test -- tests/providers/google
npm test -- tests/providers/naver
```

Expected: 각 명령 exit 0, fixture schema/parser/provider/client contract tests pass, `browserLaunchCount === 0`, `liveNetworkCallCount === 0`.

전체 명령:

```bash
npm test -- tests/providers
npm run typecheck
npm test
npm run build
```

Expected: 모두 exit 0; Google/Naver fixture에서 direct-only 최저 KRW quote와 모든 오류 case가 통과한다. Default `npm test`는 production browser factory와 real global fetch를 호출하지 않으며 browser launch/live network가 각각 0건이다.

## Output

각 병렬 작업자는 다음을 반환한다.

- changed files 전체 목록;
- 승인된 source addendum path와 approval status;
- manifest request가 해당 source findings `final_case`와 일치한다는 근거;
- 선택한 `http` 또는 `playwright` mode와 findings의 근거 위치;
- fixture 확장자, sanitization 항목, recorded/synthetic provenance 분류;
- RED 명령과 예상대로 실패한 이유;
- GREEN/typecheck/build 명령과 실제 결과;
- direct-only, 최저가, KRW, optional airline, URL, `scrapedAt`, no-direct, timeout, blocked, malformed response 각각의 test 이름;
- shared contract mismatch 유무;
- forbidden write 필요 시 수정 대신 `BLOCKED`;
- findings 부재, G1/G2 실패, selected mode 불명확, endpoint/selector 근거 불충분, Playwright dependency 부재 중 하나라도 있으면 source와 이유를 포함한 `BLOCKED`.

통합 담당자는 추가로 다음을 반환한다.

- Google/Naver changed-file 교집합이 비어 있다는 확인;
- 각 client가 findings selected mode 하나만 구현했다는 확인;
- Playwright mode면 mandatory factory injection, VITEST/CI rejection, live opt-in guard test 결과;
- HTTP mode면 fake global fetch replacement와 real fetch 0건 확인;
- Google/Naver manifest가 각자의 `final_case`를 독립적으로 소비한다는 확인;
- synthetic fixture를 live provenance로 보고하지 않았다는 확인;
- 전체 offline verification 결과;
- manual live smoke는 실행했는지, 실행하지 않았다면 `not run (manual only)`로 명시;
- Phase 2 exit gate의 PASS/BLOCKED 판정.

## Self-Review Checklist

- [x] writing-plans 필수 header와 모든 실행 step의 checkbox가 있다.
- [x] Ownership, Forbidden Writes, Dependencies, Contract, Verification, Output이 있다.
- [x] Google/Naver production, fixture, test write set이 완전히 분리돼 있다.
- [x] client/parser/provider와 sanitized fixture/parser/provider contract test 경로가 source별로 정확하다.
- [x] fixture schema, direct-only, 최저가, KRW, optional airline, URL, `scrapedAt`을 검증한다.
- [x] no direct flight, timeout, blocked, malformed response를 검증한다.
- [x] findings가 HTTP면 fetch, Playwright면 browser 중 하나만 선택하고 양쪽 구현을 금지한다.
- [x] endpoint, parameter, JSON path, DOM selector를 추측하지 않는다.
- [x] CI/default test는 offline이고 live smoke는 수동이다.
- [x] shared types 수정이 금지돼 있다.
- [x] findings 부재·실패·불일치는 `BLOCKED`다.
- [x] 모든 명령에 expected result가 있고 commit 단계가 있다.
- [x] 미확정값을 나타내는 표식이나 guessed endpoint/selector가 없다.
- [x] Naver task는 Google task의 코드 복사·치환·동일 항목 지시 없이 독립적으로 실행 가능하다.
- [x] route/date는 source별 findings `final_case`에서 읽으며 Google/Naver가 달라도 된다.
- [x] recorded provenance와 schema-preserving synthetic edge fixture를 manifest에서 구분한다.
- [x] source-specific 구현은 승인 addendum STOP gate 전에는 시작하지 않는다.
- [x] Google/Naver parser 모두 invalid `scrapedAt`을 검증한다.
- [x] Playwright client는 injected browser/page factory 없이 생성할 수 없다.
- [x] production browser factory는 VITEST/CI와 live opt-in 부재를 launch 전에 거부한다.
- [x] HTTP tests는 fake global fetch만 사용하고 default `npm test`는 browser launch/live network 0건을 assertion한다.
