# Flexible Flight Search (search-way) — Design Spec

**Date:** 2026-07-14  
**Status:** Ready for user review (self-reviewed)  
**Delivery:** MCP server (personal use)  
**Sources:** Google Flights + Naver Flights (unofficial scraping allowed)

---

## 1. Problem & Goal

사용자는 “언제 가는 게 제일 싼가?”를 알고 싶다. 고정 출발/귀국일이 아니라 아래 유연 조건으로 **왕복 직항** 후보 날짜쌍을 전수 생성한 뒤, Google Flights와 네이버 항공권 가격을 비교해 최저가 일정을 찾는다.

### Success criteria

1. 입력한 달(최대 3)·요일 필터·여행일 범위에 맞는 **모든** `(departure, return)` 쌍을 빠짐없이 열거한다.
2. 각 날짜쌍에 대해 Google·Naver **둘 다** 조회를 시도하고, 성공한 쪽 기준으로 `best`를 고른다.
3. 장시간 조회에도 MCP 타임아웃으로 전체 결과가 유실되지 않는다 (`start` → `poll` → 부분/최종 결과).
4. 결과는 가격 오름차순이며, 출처·가격·검색 URL을 포함한다.
5. 한쪽 출처 실패는 해당 셀만 실패로 기록하고, job 전체를 즉시 실패시키지 않는다.

### Non-goals (MVP)

- 웹 UI / 공개 SaaS
- 편도·멀티시티
- 성인 수·좌석 등급·경유 옵션
- 공식 항공 Open API 의존 (Amadeus 등)
- 실시간 환율 변환으로의 강제 KRW 통일
- 기존 Cursor에 연결된 타 MCP 재사용 (동작 불안정 → 무시, 본 프로젝트에서 신규 구현)

---

## 2. Product Decisions (locked)

| 항목 | 결정 |
|------|------|
| 사용 형태 | MCP 도구 (구현 단순·UI 없음) |
| 데이터 확보 | 비공식 스크래핑/내부 API 역공학 허용 |
| 여정 | 왕복만 |
| 달 | `YYYY-MM` 최대 3개 |
| 여행일 | 출발·귀국 포함 일수 **범위** (`min_trip_days` ~ `max_trip_days`) |
| 요일 | 출발/귀국 각각 0..N개, 생략 시 모든 요일 |
| 출처 | 항상 Google + Naver 동시 비교 |
| 공항 | IATA 코드만 (도시 코드 미지원) |
| 검색 깊이 | 매칭 날짜쌍 **전수** 조회 |
| 승객/좌석 | 성인 1 · 이코노미 고정 |
| 경유 | **직항만** |

---

## 3. Architecture

정공법: **도메인 코어와 전송 계층(MCP) 분리**, 긴 작업은 **job + 폴링**, 출처는 **어댑터 패턴**.

```text
[Cursor Agent]
      │ MCP (stdio)
      ▼
┌──────────────────────────┐
│ mcp-server (thin)        │  start / status / cancel
│ - Zod 입력 검증          │
│ - job_id(ULID) 발급·조회 │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│ search-orchestrator      │
│ - DateCombinator         │
│ - concurrency + backoff  │
│ - progress + partial top │
│ - job store (JSON files) │
└────────────┬─────────────┘
             │
      ┌──────┴──────┐
      ▼             ▼
 GoogleFlights   NaverFlights
 Adapter         Adapter
```

### Module responsibilities

| Module | Responsibility | Must not |
|--------|----------------|----------|
| `date-combinator` | 조건 → 날짜쌍 리스트 (순수 함수, 결정적) | 네트워크 |
| `providers/google` | 단일 날짜쌍 → 직항 왕복 최저가 + URL | 다른 출처·조합 로직 |
| `providers/naver` | 동일 | 동일 |
| `providers/types` | `Quote` 공통 타입 | 구현 세부 |
| `orchestrator` | 큐·병렬·재시도·병합·정렬·progress | HTML 파싱 |
| `job-store` | job 메타·결과·에러 append/read | 스크래핑 |
| `mcp-server` | 도구 스키마·JSON 응답 | 스크래핑·조합 세부 |

### Runtime & layout (recommended)

- **Language:** TypeScript (Node 20+) — MCP SDK·타입·검증·비동기 job에 정합
- **Package shape:** 단일 패키지 모노레포 불필요 (MVP). `src/` 아래 모듈 분리
- **Suggested tree:**

```text
src/
  domain/date-combinator.ts
  domain/types.ts
  providers/types.ts
  providers/google/
  providers/naver/
  orchestrator/
  jobs/store.ts
  mcp/server.ts
  mcp/tools.ts
tests/
docs/superpowers/specs/
```

---

## 4. MCP Tool Contract

긴 스크래핑 작업의 베스트 프랙티스: **즉시 반환하는 start + 멱등한 status + cancel**.

### 4.1 `start_flexible_search`

**Input**

```ts
{
  origin: string;                 // IATA, e.g. "ICN"
  destination: string;            // IATA, e.g. "NRT"
  months: string[];               // ["2026-09","2026-10"] length 1..3
  min_trip_days: number;          // inclusive, >= 2 (당일 왕복 제외가 기본)
  max_trip_days: number;          // >= min_trip_days
  departure_weekdays?: number[];  // 0=Sun .. 6=Sat; omit or [] = all
  return_weekdays?: number[];     // same
}
```

**Validation (reject before job)**

- IATA: `^[A-Z]{3}$` (입력은 대문자 정규화)
- `months`: 유일·정렬·유효 달·최대 3
- `min_trip_days >= 2`, `max_trip_days >= min_trip_days`, `max_trip_days <= 30`
- weekdays: 각 원소 0..6, 중복 제거

**Output**

```ts
{
  job_id: string;          // ULID
  total_pairs: number;     // combinator 결과 크기
  status: "queued";
}
```

`total_pairs === 0`이면 job을 만들지 않고 에러(조건이 비어 있음).

### 4.2 `get_search_status`

**Input:** `{ job_id: string }`

**Output**

```ts
{
  job_id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  created_at: string;       // ISO-8601
  updated_at: string;
  request: { /* echo of start input */ };
  progress: {
    total_pairs: number;
    completed_pairs: number;  // 양쪽 시도 끝난 쌍
    failed_pairs: number;     // 양쪽 모두 실패한 쌍
    google_ok: number;
    naver_ok: number;
  };
  results: SearchResultRow[];  // price asc by best.price; partial while running
  errors: Array<{
    departure_date: string;
    return_date: string;
    source: "google" | "naver";
    message: string;
    at: string;
  }>;
}
```

**`SearchResultRow`**

```ts
{
  departure_date: string;   // YYYY-MM-DD
  return_date: string;
  trip_days: number;        // inclusive
  google: Quote | null;
  naver: Quote | null;
  best: Quote & { source: "google" | "naver" };
}

type Quote = {
  price: number;
  currency: string;         // prefer "KRW"
  url: string;              // deep link or constructed search URL
  airline?: string;
  scraped_at: string;
};
```

**Sorting / best selection**

1. `best` = 성공한 quote 중 `price` 최소. 동점이면 `google` 우선(결정적 tie-break).
2. `results`는 `best.price` 오름차순. `best`가 없는 행(양쪽 실패)은 `results`에 넣지 않고 `failed_pairs`·`errors`로만 추적.
3. 양쪽 quote 통화가 다르면 `best`를 만들지 않고 해당 쌍은 `results`에서 제외, `errors`에 `currency_mismatch` 기록(거짓 최저가 방지). MVP 파서는 양 출처 모두 **KRW**를 목표로 한다.

### 4.3 `cancel_search`

**Input:** `{ job_id: string }`  
**Effect:** in-flight 작업 중단 플래그, 이미 완료된 부분 결과는 status로 조회 가능, `status=cancelled`.

---

## 5. Date Combinator

순수·결정적·단위 테스트 최우선 모듈.

### Algorithm

1. `months`의 각 달에 대해 달력상 모든 날짜 `D`를 나열한다.
2. 각 `D`에 대해:
   - `departure_weekdays`가 비어 있지 않으면 `weekday(D)`가 집합에 있을 때만 출발 후보.
3. 각 출발일 `dep`와 각 `trip_days ∈ [min, max]`에 대해  
   `ret = dep + (trip_days - 1) days` (포함 일수 정의).
4. `ret`의 월이 `months`에 **포함되지 않아도** 허용한다.  
   (예: 10월 출발 · 여행 5일 → 11월 초 귀국. “선택한 달”은 **출발 가능 구간**으로 해석하는 것이 UX·구현 모두 단순.)
5. `return_weekdays` 필터 적용.
6. `(dep, ret)` 중복 제거 후 `dep` 오름차순, 같으면 `ret` 오름차순.

### Inclusive trip days example

- `dep=2026-10-01`, `trip_days=5` → `ret=2026-10-05` (1,2,3,4,5일 = 5일).

### Complexity note

최악: 3달 ≈ 92일 × trip range(예: 7) ≈ 수백 쌍 × 2 sources. Orchestrator가 이를 전제로 rate limit한다.

---

## 6. Data Acquisition Strategy

기존 외부 MCP는 사용하지 않는다. 본 레포에서 provider를 직접 구현·고정한다.

### 6.1 Shared provider interface

```ts
interface FlightProvider {
  readonly id: "google" | "naver";
  findDirectRoundTrip(input: {
    origin: string;
    destination: string;
    departure_date: string;
    return_date: string;
  }): Promise<Quote>;
}
```

실패는 throw → orchestrator가 catch해 `errors`에 기록.

### 6.2 Google Flights adapter (MVP approach)

**정공법 순서**

1. **Spike (구현 1주차 게이트):** 알려진 노선·날짜로 응답 HTML/내부 XHR을 캡처해, 직항 왕복 최저가·통화·딥링크를 안정적으로 파싱할 수 있는 경로를 확정한다.
2. 우선순위:
   - (선호) Google Flights가 브라우저에서 쓰는 **내부 API/JSON**을 재현 가능한 경우 → HTTP client로 호출
   - (대안) headless browser(Playwright)로 결과 DOM/네트워크 응답에서 추출
3. 직항 필터: 출처 UI/API의 nonstop 필터와 동일하게 적용. 파싱 후 경유 포함이면 폐기하고 “직항 없음”으로 실패 처리(가짜 최저가 금지).
4. URL: 가능하면 공식 검색 URL을 구성해 `Quote.url`에 넣는다.

**리스크:** 봇 차단·DOM 변경. 완화: User-Agent·간격·재시도, 파서 버전 핀, spike 실패 시 fixture 기반 회귀 테스트.

### 6.3 Naver Flights adapter (MVP approach)

**정공법 순서**

1. **Spike:** 네이버 항공권 검색의 네트워크 탭에서 실제 가격 API(모바일/PC)를 식별한다.
2. 가능하면 **공식 UI가 쓰는 JSON API**를 동일 파라미터로 호출(스크래핑보다 안정).
3. 파라미터: 출발/도착 공항, 출발일, 귀국일, 성인 1, 직항 필터.
4. 응답에서 최저 직항 왕복가·예약/검색 링크 추출.

**리스크:** 비공개 API 스키마 변경·약관. 완화: 스키마 스냅샷 테스트, 어댑터 경계로 파싱 격리.

### 6.4 Feasibility gate (must pass before full MCP polish)

문서화·설계 직후 구현 Phase 0:

| Gate | Pass criteria |
|------|----------------|
| G1 Google spike | 동일 노선·날짜로 직항 왕복가 조회 **연속 3회 성공** |
| G2 Naver spike | 동일 |
| G3 Combinator | 단위 테스트로 요일·범위·포함 일수 엣지 케이스 통과 |
| G4 Orchestrator dry-run | mock provider로 50쌍 job start/status/cancel 동작 |

Phase 0 통과 조건: **G1 ∧ G2 ∧ G3** (G4는 Phase 1 완료 기준).  
G1 또는 G2 실패 시: 해당 출처를 스펙에서 제외하거나 방법을 개정 — **추정·가짜 가격으로 진행하지 않음**.

---

## 7. Orchestrator & Job Store

### Concurrency & politeness

- 출처별 **독립 큐** (Google 부하가 Naver를 막지 않음).
- 기본: 출처당 concurrency `2`, 요청 간 delay `500–1500ms` jitter (설정 가능).
- 429/차단 징후: exponential backoff + 해당 출처 일시 pause.
- 재시도: 일시 오류 최대 3회, 이후 그 셀 실패.

### Job lifecycle

```text
queued → running → completed
                 → cancelled
                 → failed   (시작 불가·스토어 손상 등 시스템 실패만)
```

날짜쌍 일부 실패는 `completed` + `failed_pairs > 0`이 정상.

### Persistence

- `data/jobs/{job_id}.json`에 request·progress·results·errors를 영속화한다 (MVP는 JSON 파일; SQLite는 v2).
- 프로세스 재시작 시 미완료(`running`) job은 `failed` + `interrupted`로 표시한다. **자동 재개(resume)는 v2**.
- `cancel`은 cooperative cancellation (다음 태스크 시작 전 플래그 확인).

### Partial results

- 쌍이 완료될 때마다 results에 merge + `best.price`로 재정렬.
- `get_search_status`는 항상 현재 스냅샷을 반환 (읽기 락 짧게).

---

## 8. Error Handling

| Case | Behavior |
|------|----------|
| Invalid input | start 거부, job 없음 |
| Provider timeout | retry → cell error |
| No direct flight | cell error `no_direct_flight`, 다른 출처는 계속 |
| Both sources fail for pair | `failed_pairs++`, results 제외 |
| Currency mismatch | cell error, 비교 안 함 |
| Job cancel | 부분 results 유지, status=cancelled |
| Disk full / store error | status=failed |

사용자(에이전트)에게는 `errors` 요약과 성공한 `results`를 함께 보여 “부분 성공”이 기본 UX.

---

## 9. Testing Strategy

| Layer | What | How |
|-------|------|-----|
| Unit | DateCombinator | 고정 달력 케이스 테이블 |
| Unit | best/sort/currency rules | fixture quotes |
| Contract | Provider parsers | recorded HTTP/JSON fixtures (VCR) |
| Integration | Orchestrator | mock providers, fake timers |
| Smoke | MCP tools | in-process server + start/status |
| Manual | Live spike | G1/G2 only, CI 기본은 fixture |

CI에서는 **라이브 스크래핑을 돌리지 않는다** (불안정·차단·약관). 라이브는 로컬/수동 게이트.

---

## 10. Security, Ethics, Ops

- API 키·쿠키가 필요하면 `.env` + gitignore. 시크릿 커밋 금지.
- 과도한 동시성으로 상대 서비스에 DoS에 가까운 부하를 주지 않음 (politeness 기본값 유지).
- 개인 사용 전제. 재배포·상업적 대량 스크래핑은 본 스펙 범위 밖.
- User-Agent·요청 헤더는 최소·정직하게; 자격 증명 공유 금지.

---

## 11. Implementation Phases

1. **Phase 0 — Feasibility:** Google/Naver live spike (G1–G2) + combinator unit tests (G3)
2. **Phase 1 — Core:** types, combinator, orchestrator + JSON job store + mocks (G4)
3. **Phase 2 — Providers:** real adapters behind interface, fixture/VCR tests
4. **Phase 3 — MCP:** three tools, end-to-end local smoke
5. **Phase 4 — Harden:** backoff tuning, better URLs, error taxonomy

Phase 0(G1–G3) 실패 시 Phase 2+를 강행하지 않고 스펙/범위를 개정한다.

---

## 12. Open Risks (accepted)

1. 스크래핑/비공식 API는 **언제든 깨질 수 있음** — 어댑터 격리로 피해 범위를 출처 단위로 제한.
2. 전수 조회는 **수 분~수십 분** 가능 — job 폴링이 필수인 이유.
3. Google·Naver 가격 구성(수하물·특가)이 다를 수 있음 — “표시가 기준”이며 예약 전 링크에서 재확인.
4. 귀국일이 선택 달 밖일 수 있음 — §5에서 의도적으로 허용; 달로 귀국을 제한하려면 v2 옵션.

---

## 13. Glossary

- **trip_days (inclusive):** 출발일과 귀국일을 모두 센 일수.
- **date pair:** `(departure_date, return_date)`.
- **cell:** 한 date pair × 한 source 조회 단위.
- **best:** 한 date pair에서 비교 가능한 quote 중 최저가.

---

## Appendix A — Example request/response

**Start**

```json
{
  "origin": "ICN",
  "destination": "NRT",
  "months": ["2026-10", "2026-11"],
  "min_trip_days": 4,
  "max_trip_days": 6,
  "departure_weekdays": [5, 6],
  "return_weekdays": [0, 1]
}
```

**Status (partial)**

```json
{
  "job_id": "01J...",
  "status": "running",
  "progress": {
    "total_pairs": 48,
    "completed_pairs": 12,
    "failed_pairs": 1,
    "google_ok": 11,
    "naver_ok": 10
  },
  "results": [
    {
      "departure_date": "2026-10-10",
      "return_date": "2026-10-13",
      "trip_days": 4,
      "google": { "price": 289000, "currency": "KRW", "url": "https://...", "scraped_at": "..." },
      "naver": { "price": 301000, "currency": "KRW", "url": "https://...", "scraped_at": "..." },
      "best": { "source": "google", "price": 289000, "currency": "KRW", "url": "https://...", "scraped_at": "..." }
    }
  ],
  "errors": []
}
```
