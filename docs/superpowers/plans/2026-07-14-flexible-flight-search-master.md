# Flexible Flight Search Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 최대 3개월의 유연 조건에 맞는 모든 왕복 직항 날짜쌍을 Google Flights와 Naver Flights에서 비교하고, 장시간 작업을 MCP job으로 안전하게 조회·취소할 수 있는 개인용 서버를 구축한다.

**Architecture:** 공통 타입 계약을 먼저 고정한 뒤, feasibility gate, 순수 도메인·job core, 두 provider 어댑터, MCP 전송 계층, 운영 안정화 순으로 진행한다. Google/Naver처럼 write set이 분리된 작업은 병렬화하고, 각 Phase 종료 시 독립 검증과 통합 gate를 통과해야 다음 단계로 이동한다.

**Tech Stack:** Node.js 20+, TypeScript, npm, Vitest, Zod, ULID, MCP TypeScript SDK, provider spike에서 확정한 HTTP 또는 Playwright 접근

---

## Source of Truth

- Design: `docs/superpowers/specs/2026-07-14-flexible-flight-search-design.md`
- Shared contracts: `docs/superpowers/plans/2026-07-14-flexible-flight-search-contracts.md`
- 이 문서는 실행 순서와 gate만 관리한다. 구체적 TDD 단계와 코드는 각 Phase 문서가 소유한다.

## Plan Set

1. `docs/superpowers/plans/2026-07-14-flexible-flight-search-contracts.md`
2. `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-feasibility.md`
3. `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase1-core.md`
4. `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase2-providers.md`
5. `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase3-mcp.md`
6. `docs/superpowers/plans/2026-07-14-flexible-flight-search-phase4-harden.md`
7. `docs/superpowers/plans/2026-07-14-flexible-flight-search-integration.md`

Phase 0 findings가 생성된 뒤 실제 endpoint/path/selector가 확정되면 Phase 2 계획이 source별 `phase2-google-addendum.md`와 `phase2-naver-addendum.md`를 생성한다. Phase 4 URL recipe가 캡처로 입증된 source에만 `phase4-<source>-url-addendum.md`를 생성한다. 이 동적 addendum는 관찰 전에는 만들거나 추측하지 않는다.

## Phase DAG

```text
Phase 0a: shared contracts / project bootstrap
                  │
                  ▼
Phase 0b: feasibility
  ├─ G1 Google live spike ─┐
  ├─ G2 Naver live spike  ─┼─ gate: G1 ∧ G2 ∧ G3
  └─ G3 date combinator   ─┘
                  │
                  ▼
Phase 0c: acquisition dependency reconciliation
  └─ selected mode가 Playwright인 source가 있을 때만
     package.json/package-lock.json에 playwright 추가
                  │
                  ▼
Phase 1: core + G4 orchestrator dry-run
                  │
                  ▼
Phase 2: providers
  ├─ Google adapter ─┐
  └─ Naver adapter  ─┴─ fixture contract gate
                  │
                  ▼
Phase 3: MCP tools + local smoke
                  │
                  ▼
Phase 4: hardening
                  │
                  ▼
Integration: full offline suite + one manual live job
```

## Global Rules

- 실행 전 `git rev-parse --is-inside-work-tree`가 `true`여야 한다. 아니라면 사용자가 저장소 초기화 또는 commit-free 실행을 명시적으로 선택할 때까지 commit 단계에 진입하지 않는다.
- 구현 변경은 test-first로 진행한다: RED 확인 → 최소 구현 → GREEN 확인 → commit.
- CI와 기본 `npm test`에서는 live scraping을 실행하지 않는다.
- `.env`, 쿠키, API key, 캡처된 개인 식별 정보는 커밋하지 않는다.
- provider 하나의 실패는 cell error이며 job system failure가 아니다.
- 모든 date pair에 Google과 Naver를 각각 한 번 이상 시도한다. 취소가 요청된 뒤 시작되지 않은 cell은 예외다.
- 선택 달은 출발일 범위다. 귀국일은 선택 달 밖이어도 허용한다.
- `tripDays`는 출발일과 귀국일을 모두 포함한다.
- 가격 통화가 다르면 숫자만 비교하지 않으며 해당 pair를 결과에서 제외한다.
- `results`는 항상 `best.price` 오름차순이고 동점 best는 Google이다.
- Google/Naver scheduler는 orchestrator 인스턴스 전체 job이 source별로 공유한다. 여러 동시 job의 합산 concurrency 기본값도 source별 `2`다.

## Phase 0 Exit Gate

- G1: 동일 Google 노선·날짜에서 직항 왕복 `price`, `currency`, `url`을 3회 연속 얻는다.
- G2: 동일 Naver 노선·날짜에서 동일 조건을 3회 연속 얻는다.
- G3: date combinator의 달 경계, 윤년, 요일, 포함 일수, 중복 제거 테스트가 통과한다.
- G1 또는 G2가 실패하면 Phase 2 이상을 시작하지 않는다. 응답 구조와 실패 근거를 문서화하고 설계 범위를 사용자와 다시 결정한다.

## Phase 1 Exit Gate

- mock provider로 50쌍을 처리하고 partial status가 증가한다.
- 두 source 큐가 독립적으로 진행된다.
- 한 source 실패와 양쪽 실패가 정확히 집계된다.
- cancel 뒤 새 cell을 시작하지 않으며 부분 결과를 보존한다.
- JSON store round-trip, 원자적 write, 재시작 시 interrupted 처리 테스트가 통과한다.

Phase 1 착수 전 또는 늦어도 Phase 2 착수 전, contracts 계획의 Task 4를 실행한다. 두 source가 HTTP면 package 변경 없이 통과하고, 하나라도 Playwright면 검증된 browser runtime을 manifest와 lockfile에 고정한다.

## Phase 2 Exit Gate

- Google/Naver parser가 각자 기록 fixture에서 직항 왕복 최저 KRW quote를 추출한다.
- 경유만 있거나 결과가 없으면 `no_direct_flight`로 분류한다.
- 네트워크 없이 provider contract suite가 통과한다.
- Phase 0 findings와 실제 adapter 방식이 일치한다.

## Phase 3 Exit Gate

- `start_flexible_search`, `get_search_status`, `cancel_search`가 MCP tools list에 나타난다.
- 유효하지 않은 입력은 job 생성 전에 거부된다.
- start는 job id와 total pairs를 즉시 반환한다.
- status는 partial/final snapshot을 snake_case 계약으로 반환한다.
- in-process MCP smoke와 빌드된 stdio server smoke가 통과한다.

## Phase 4 Exit Gate

- 429와 일시 오류에 exponential backoff와 source별 pause가 적용된다.
- transient 오류는 최초 시도 뒤 최대 3회 재시도하여 총 시도 횟수가 4회를 넘지 않으며, 영구 오류는 재시도하지 않는다.
- 오류 코드와 사용자 메시지가 안정적이다.
- 검색 URL은 동일 공항·날짜·왕복·직항 조건을 재현한다.
- 전체 offline test, typecheck, build가 통과한다.

## Phase 0 Parallel Workstreams

### Workstream A — Date combinator

- **Ownership:** `src/domain/date-combinator.ts`, `tests/domain/date-combinator.test.ts`
- **Forbidden Writes:** `scripts/**`, `src/providers/**`, `src/orchestrator/**`, `src/jobs/**`, `src/mcp/**`
- **Dependencies:** contracts plan 완료
- **Contract:** `FlexibleSearchRequest`, `DatePair`
- **Verification:** `npm test -- tests/domain/date-combinator.test.ts`

### Workstream B — Google feasibility

- **Ownership:** `scripts/spike-google.ts`, `docs/spikes/2026-07-14-google-findings.md`
- **Forbidden Writes:** `src/**`, `tests/**`, Naver findings
- **Dependencies:** package bootstrap 완료
- **Contract:** CLI 입력과 `Quote` 필드
- **Verification:** 같은 CLI 명령 3회 연속 성공

### Workstream C — Naver feasibility

- **Ownership:** `scripts/spike-naver.ts`, `docs/spikes/2026-07-14-naver-findings.md`
- **Forbidden Writes:** `src/**`, `tests/**`, Google findings
- **Dependencies:** package bootstrap 완료
- **Contract:** CLI 입력과 `Quote` 필드
- **Verification:** 같은 CLI 명령 3회 연속 성공

## Phase 2 Parallel Workstreams

### Workstream A — Google provider

- **Ownership:** `src/providers/google/**`, `tests/providers/google/**`
- **Forbidden Writes:** shared types, Naver, orchestrator, MCP
- **Dependencies:** Phase 0 G1 findings, Phase 1 core
- **Contract:** `FlightProvider`
- **Verification:** `npm test -- tests/providers/google`

### Workstream B — Naver provider

- **Ownership:** `src/providers/naver/**`, `tests/providers/naver/**`
- **Forbidden Writes:** shared types, Google, orchestrator, MCP
- **Dependencies:** Phase 0 G2 findings, Phase 1 core
- **Contract:** `FlightProvider`
- **Verification:** `npm test -- tests/providers/naver`

## Integration Order

1. contracts branch/change set
2. Phase 0 combinator, Google spike, Naver spike
3. Phase 0 gate review
4. acquisition dependency reconciliation
5. Phase 1 core
6. Phase 2 Google and Naver providers
7. Phase 3 MCP
8. Phase 4 hardening
9. integration plan

## Master Verification

Run after every merged Phase:

```bash
npm run typecheck
npm test
npm run build
```

Expected: all commands exit 0 and test output contains no live provider request.

## Required Workstream Report

Every implementation agent must return:

- changed files;
- commands run and pass/fail result;
- contract mismatch, if any;
- gate evidence;
- `BLOCKED` rather than modifying forbidden files.
