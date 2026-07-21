# Flexible Search 중단(Stall) 원인 분석

- **일시:** 2026-07-21
- **현상:** `get_search_status` 진행률(`completed_pairs`)과 `updated_at`이 수 분~십수 분 동안 변하지 않음. `cancel_search` 후에도 후속 잡이 `completed_pairs = 0`인 채 대기하는 경우가 발생.
- **범위:** search-way MCP 프로세스 내부 orchestrator / `SourceScheduler` / Playwright Google·Naver provider

---

## 1. 한 줄 결론

**모든 flexible search job이 Google·Naver 각각 하나의 `SourceScheduler`를 공유하는데, Playwright 호출이 abort/cancel에 반응하지 않고 hang되면 그 스케줄러의 concurrency 슬롯이 반환되지 않는다.**  
그러면 같은 MCP 프로세스에서 돌아가는 **다른 job의 pair 작업까지 큐에서 영원히(또는 매우 오래) 대기**한다. UI/MCP 입장에서는 “검색이 멈춘 것”으로 보인다.

PUS→PQC 검색이 자주 표면에 보인 이유는 PQC가 본질적으로 깨져서가 아니라, **동시 다잡 실행 중 hang이 PQC 구간에서 터졌고**, 그 여파로 CXR·후속 PQC가 막혔기 때문이다.

---

## 2. 관측된 증상 (재구성)

### 2.1 세션 타임라인 (2026-07-21, UTC)

거의 동시에 세 job을 시작:

| job_id (끝 6자) | 목적지 | created_at | 최종 | completed/total | 비고 |
|-----------------|--------|------------|------|-----------------|------|
| `0CXCPR` | HAN | 01:57:40 | completed ~01:59:28 | **31/31** | ~108초에 정상 완료 |
| `FSWKHA` | PQC | 01:57:40 | cancelled ~02:03:18 | **~5/31에서 stall** | 마지막 스크레이프 ~01:59:40 이후 `updated_at` 고정 |
| `D14PA3` | CXR | 01:57:40 | completed ~02:05:08 | **31/31** | stall 구간 동안 **0/31**. PQC cancel 직후 급진전 |

해석:

1. HAN은 공유 큐 앞쪽에서 먼저 소진되어 끝난다.
2. PQC가 in-flight hang에 들어가면 Google/Naver 슬롯이 반환되지 않는다.
3. CXR pair들은 이미 같은 스케줄러 큐에 enqueue되어 있으나, **앞선 PQC active/queued 작업이 막혀 실행되지 못한다** → `completed_pairs = 0`.
4. PQC를 `cancel`하면 **아직 시작하지 않은** PQC 큐 항목은 `shouldStop()`으로 `cancelled`로 빠진다. 슬롯이 일부라도 비면 CXR가 진행한다.

### 2.2 반복된 PQC stall 패턴

| job_id (끝 6자) | 진행이 멈춘 지점 | 이후 상태 |
|-----------------|------------------|-----------|
| `30NXB6` | 5~7/31 | cancel. errors에 `Provider request timed out` 존재 |
| `V156FS` | 4/27 | cancel |
| `FSWKHA` | 5/31 | cancel (위 타임라인) |
| `K1146T` | 2/18 | cancel |
| `H0T9C5` | **0/8** | cancel — **한 pair도 시작 못 함** |
| `9B396G` | **0/10** | cancel — 동시 시작, 동일 |

`0/n` stall은 “PQC HTML이 특별히 안 된다”가 아니라, **이미 hang 중인 선행 job이 공유 스케줄러를 점유한 뒤** 새 job만 enqueue되고 drain되지 못한 상태와 일치한다.

### 2.3 Stall의 외부 징후

MCP/`get_search_status` 기준:

- `status`는 계속 `"running"` (또는 cancel 전까지)
- `progress.completed_pairs` 불변
- `updated_at` 불변 (pair 완료 시에만 store update로 갱신됨)
- `results`/`errors`에 새 항목 없음
- 수 분 대기해도 회복되지 않음 (정상 pair는 보통 수 초~수십 초 단위로 증가)

---

## 3. 런타임 구조 (왜 “한 job이 전체를 멈출 수 있는가”)

### 3.1 MCP 프로세스당 스케줄러 1쌍

`composeProductionStack` (`src/mcp/server.ts`)은 production 기동 시:

- `SourceScheduler` Google 인스턴스 **1개**
- `SourceScheduler` Naver 인스턴스 **1개**

를 만들고, `createSearchOrchestrator({ schedulers })`에 주입한다.

기본 concurrency (`src/config/runtime.ts`):

- `SEARCH_WAY_PROVIDER_CONCURRENCY` 기본값 **6** (출처당)
- 즉 동시에 Google 페이지 작업 ≤ 6, Naver ≤ 6

**Job A와 Job B는 스케줄러를 나누지 않는다.**  
Job A의 hang 6개가 Google 슬롯을 채우면 Job B의 Google 작업은 큐에서 대기만 한다.

### 3.2 Job 시작 시 모든 pair를 즉시 enqueue

`execute` (`src/orchestrator/index.ts`):

```ts
const pairPromises = pairs.map(async (pair) => {
  const [googleOutcome, naverOutcome] = await Promise.all([
    schedulers.google.add(() => google.findDirectRoundTrip(input), token),
    schedulers.naver.add(() => naver.findDirectRoundTrip(input), token),
  ]);
  // ... store update (completed_pairs++)
});
await Promise.all(pairPromises);
```

의미:

1. `pairs.length`가 31이면 Google 큐에 최대 31개, Naver 큐에 최대 31개가 **거의 동시에** push된다.
2. 여러 job을 연달아 `start`하면, 마이크로태스크 순서상 **먼저 start된 job의 pair들이 큐 앞쪽**을 차지한다.
3. 각 pair는 Google·Naver **둘 다** 끝나야 `completed_pairs`가 증가한다. 한쪽만 hang이어도 해당 pair promise는 대기한다.

### 3.3 `SourceScheduler`의 슬롯 모델

`src/orchestrator/queue.ts`:

- `active < concurrency`일 때만 `run(item)` 시작
- `run`의 `finally`에서 `active -= 1` 후 `drain()`
- **`await item.task()`가 resolve/reject될 때까지 `active`는 줄어들지 않음**

따라서 `item.task()`(= `findDirectRoundTrip` → Playwright)가 hang이면:

- 해당 슬롯은 영구 점유에 가깝게 동작
- 뒤 큐 항목은 `drain`되지 않음
- 다른 job의 `add()`로 들어간 작업도 같은 큐 뒤에서 대기

---

## 4. Cancel이 stall을 바로 풀지 못하는 이유

### 4.1 설계: cooperative cancellation

스펙 (`docs/superpowers/specs/2026-07-14-flexible-flight-search-design.md`):

> `cancel`은 cooperative cancellation (다음 태스크 시작 전 플래그 확인)

`cancel` 구현 (`src/orchestrator/index.ts`):

1. `runtime.cancellationRequested = true`
2. job JSON `status = "cancelled"`

스케줄러는 `token.shouldStop()`이 true일 때 **아직 `item.task()`에 들어가기 전**이면 `{ kind: "cancelled" }`로 resolve한다.

체크 위치 (`queue.ts` `run`):

- 태스크 시작 직전
- jitter delay 후
- pause 대기 후
- `beforeAttempt` 후
- 재시도 루프 각 attempt 전·후

**체크하지 않는 구간:**

```ts
const quote = await item.task(); // ← 여기 안에서는 shouldStop을 보지 않음
```

### 4.2 Cancel 후 pair 쪽 동작

`execute`에서 google/naver 중 하나가 `cancelled` cell이면 해당 pair는 store를 갱신하지 않고 `return`한다.

- 이미 끝난 부분 결과는 job 파일에 남음 (의도된 동작)
- **그러나 hang 중인 `item.task()`는 cancel 플래그와 무관하게 계속 실행**
- 그 task가 끝나기 전까지 `active` 슬롯 미반환 → **다른 job 차단 지속**

그래서 “잡 상태는 cancelled인데, 프로세스 전체 검색은 여전히 멈춘 것처럼” 보일 수 있다.

---

## 5. Playwright 경로에서 hang이 길어지는 지점

### 5.1 Provider 쪽 30초 AbortController

`GoogleFlightProvider` / `NaverFlightProvider`:

- `requestTimeoutMs` 기본 **30_000**
- `AbortController.abort()`로 `client.search(input, signal)`에 전달

이론상 30초 후 AbortError → `provider_timeout` → 재시도(최대 `maxRetries+1`회, 기본 재시도 정책상 수 회) → 셀 실패로 끝나야 한다.

실제로 일부 job errors에 `Provider request timed out`이 기록된 것은 **abort가 먹는 경로도 존재**함을 보여 준다.

### 5.2 Abort가 무력화되는 구간: `createPage()`

Google 클라이언트 (`src/providers/google/client.ts` `PlaywrightGoogleClient.search`):

```ts
const { page, cleanup } = await this.factory.createPage(); // signal 미전달
try {
  if (signal?.aborted) { throw AbortError; }
  await page.goto(url, { timeout: 120_000, signal });
  await waitForReadyHtml(page, polling, signal);
} finally {
  await cleanup();
}
```

Naver 클라이언트도 동일한 순서다.

`ProductionGoogleBrowserFactory.createPage` / Naver factory:

1. shared browser acquire (`launch` / 기존 인스턴스)
2. `browser.newContext(...)`
3. resource route 설치
4. `context.newPage()`

이 구간에는:

- `AbortSignal`이 전달되지 않음
- 별도 Promise.race 타임아웃 없음

따라서 **browser/context/page 생성이 Playwright/OS 수준에서 블록**되면:

- 30초 abort 타이머는 이미 돌았거나 돌아도 `search` 본문에 도달하지 못함
- `item.task()`는 끝나지 않음
- 스케줄러 슬롯 미반환

동시 context가 많을 때(출처당 6 × 2 job 이상) shared Chromium이 불안정해지면 이 구간에 들어가기 쉽다.

### 5.3 `page.content()` / readiness 폴링

`waitForReadyHtml` (Google):

- 기본 `maxAttempts = 120`, `pollIntervalMs = 1000` → **최대 약 120초** “결과가 안 뜨는” 정상 대기 가능
- 매 루프 시작 시 `throwIfAborted(signal)` 호출
- 그러나 **`await page.content()`가 반환하지 않으면** abort 체크에 다시 오지 못함

Naver `waitForReadyBody`도 동일 패턴이다.

`page.goto`는 `timeout: 120_000`과 `signal`을 받지만, Playwright 버전에 따라 signal 중단이 즉시가 아니거나, goto 이후 content 호출에서 hang이 나면 goto timeout과 무관하다.

### 5.4 Timeout·재시도로 “설명되는 지연” vs “설명되지 않는 stall”

정상 실패 경로의 상한(대략):

| 단계 | 상한 |
|------|------|
| provider abort | 30s / attempt |
| 재시도 | `maxRetries` 기본 3 → attempt 최대 4회 전후 |
| 시도 사이 backoff | `retryBaseDelayMs`(1s) × 지수 + jitter |
| 합(대략) | **수 분 이내**에 셀 실패로 끝나야 함 |

관측된 stall:

- **수 분 이상** `completed_pairs` 무증가
- 후속 job **0/n**이 cancel될 때까지 지속

이는 “느린 성공/실패”가 아니라 **task promise 미종료 + 슬롯 미반환** 모델과 맞다.  
(일부 pair는 timeout으로 errors에 남고, 다른 in-flight는 createPage/content hang으로 남았을 가능성)

---

## 6. 인과 체인 (정리)

```text
[트리거]
  동일 MCP 프로세스에서 job 여러 개 start
  또는 단일 job이라도 concurrency만큼 Playwright 동시 실행
       │
       ▼
[공유 큐]
  Google SourceScheduler (concurrency=6)
  Naver  SourceScheduler (concurrency=6)
       │
       ▼
[hang]
  createPage() 또는 page.content()/goto 경로에서
  AbortSignal·shouldStop이 개입하지 못함
       │
       ▼
[슬롯 고갈]
  active가 concurrency에 고정
  drain()이 후속 QueueTask를 꺼내지 못함
       │
       ▼
[증상]
  ① hang job: completed_pairs / updated_at 정지 (running)
  ② 다른 job: start는 됐지만 completed_pairs=0 (큐 대기)
  ③ cancel: status만 cancelled, in-flight hang은 계속 슬롯 점유
  ④ hang이 풀리거나 프로세스 재시작 전에는 회복 불안정
```

---

## 7. “PQC 문제”로 오인하기 쉬운 이유와 반증

### 오인 포인트

- stall이 반복적으로 PQC job에서 관측됨
- PQC는 `no_direct_flight` / parse 실패 / timeout 비율이 HAN·CXR보다 높을 수 있음

### 반증

- **동일 조건·동일 인프라**에서 HAN 31/31, CXR 31/31 완료
- CXR는 PQC와 **같은 초에 start**되었으나 PQC stall 동안 0건 → PQC cancel 후 완료  
  → 목적지 HTML 고유 버그라기보다 **큐 위치 + hang 타이밍**
- PQC 재시도가 **0/8, 0/10**인 구간은 PQC 요청조차 실행되지 못한 상태 (스케줄러 전단 차단)

PQC가 하는 역할은 기껏해야 **hang·timeout을 더 자주 유발하는 부하/불안정 트래픽**이지, stall의 필요충분조건이 아니다.

---

## 8. 관련 코드·설정 인덱스

| 주제 | 위치 |
|------|------|
| 스케줄러 싱글톤 주입 | `src/mcp/server.ts` — `composeProductionStack` |
| pair enqueue / cancel 플래그 | `src/orchestrator/index.ts` — `execute`, `cancel` |
| cooperative queue / active 슬롯 | `src/orchestrator/queue.ts` — `add`, `drain`, `run` |
| concurrency·timeout 기본값 | `src/config/runtime.ts` — `concurrencyPerSource=6`, `requestTimeoutMs=30000` |
| Google createPage·goto·poll | `src/providers/google/client.ts` |
| Naver createPage·goto·poll | `src/providers/naver/client.ts` |
| 30s AbortController | `src/providers/google/provider.ts`, `src/providers/naver/provider.ts` |
| cancel 설계 문구 | `docs/superpowers/specs/2026-07-14-flexible-flight-search-design.md` §7 |
| 증거 job JSON | `data/jobs/01KY16980HFTY18H8TQ2FSWKHA.json` 외 `01KY14*`, `01KY15*`, `01KY16*`, `01KY17*` |

---

## 9. 수정 방향 (원인에 직접 대응하는 것만)

구현 여부와 무관하게, 위 인과를 끊으려면 다음이 필요하다.

1. **`item.task()` hard deadline**  
   `createPage` 포함 전체를 `AbortSignal` 또는 `Promise.race(timeout)`으로 감싸고, 만료 시 page/context를 강제 `close`해 task를 reject시킨다.

2. **Cancel 시 in-flight 강제 중단**  
   job cancel → 해당 token뿐 아니라 진행 중 Playwright resource를 abort/close하여 스케줄러 `active`를 즉시 감소시킨다.

3. **Job 격리 또는 전역 in-flight 상한**  
   - job별 스케줄러, 또는  
   - 프로세스 전역 “동시에 하나의 flexible job만 running”  
   중 하나로 **한 job hang → 다른 job 0건**을 제거한다.

4. **Stall watchdog**  
   `updated_at`이 N초 이상 불변이면 해당 job을 failed/cancelled로 승격하고 in-flight를 강제 정리한다. (증상 완화 + 운영 가시성)

5. **회귀 테스트**  
   mock provider가 특정 task에서 영원히 pending일 때, job B `start` 후 제한 시간 내 진행(또는 명확한 실패)하는지 검증한다.

---

## 10. 요약

| 질문 | 답 |
|------|----|
| 무엇이 멈춘 것처럼 보였나? | pair 진행률/`updated_at` 정지, 후속 job 0건 |
| 직접 원인인가? | 공유 `SourceScheduler` 슬롯이 Playwright hang에 점유됨 |
| 왜 cancel로 즉시 안 풀리나? | cancel은 큐 대기분만 cooperative 취소; in-flight `task()`는 미중단 |
| 왜 abort(30s)로 부족한가? | `createPage()` 및 일부 page API hang에는 signal이 닿지 않음 |
| PQC 탓인가? | 아님. 동시 실행·큐 위치·hang 타이밍의 표면; HAN/CXR는 동일 스택으로 완료 |
| 근본 해결은? | in-flight hard abort + 슬롯 강제 회수 + job 간 격리/상한 |

---

## 11. 구현 결과 (2026-07-21)

§9의 수정 방향이 같은 날 구현되었다. 속도 관련 설정(동시성 6, 전 pair 동시 enqueue, 공유 스케줄러)은 유지하고, "task는 유한 시간 내 반드시 settle된다"는 불변식만 추가했다.

| 항목 | 구현 |
|------|------|
| Abort → 강제 종료 | `PlaywrightGoogleClient`/`PlaywrightNaverClient`가 abort 시 page/context를 즉시 close하여 hang된 `goto`/`content()`/`innerText()`를 reject시킴. `createPage(signal)`은 각 단계에서 abort와 race하고, 늦게 도착한 orphan context/page를 close. browser launch에도 60초 데드라인 (`launchTimeoutMs`). 참고: Playwright `goto`는 `signal` 옵션을 지원하지 않아 기존 전달은 무의미했음 |
| 스케줄러 hard deadline | `SourceScheduler`가 attempt마다 `AbortSignal`을 task에 전달하고 `taskDeadlineMs`(기본 `requestTimeoutMs + 15s`) 만료 시 abort. `taskKillGraceMs`(기본 10s) 내에도 settle하지 않으면 task를 abandon하고 슬롯을 강제 회수 (`TimeoutError` → `provider_timeout`으로 분류·재시도) |
| Cancel in-flight 전파 | job runtime마다 `AbortController`. `cancel()`이 abort → in-flight task 즉시 중단·슬롯 반환. 단 kill grace 내에 성공으로 settle한 결과는 부분 결과로 보존 (기존 cancel 스펙 유지) |
| Stall watchdog | pair 진행이 `stallTimeoutMs`(기본 10분) 이상 없으면 job을 `failed` / `failureReason: "stalled"`로 승격하고 in-flight abort |
| 신규 env | `SEARCH_WAY_TASK_DEADLINE_MS`, `SEARCH_WAY_TASK_KILL_GRACE_MS`, `SEARCH_WAY_STALL_TIMEOUT_MS` |
| 회귀 테스트 | `tests/orchestrator/stall-hardening.test.ts` (deadline 슬롯 회수, abort 무시 task 강제 회수, cancel in-flight, hang job이 후속 job을 굶기지 못함, watchdog), `tests/providers/google/abort-hard-close.test.ts` (abort → page close, createPage 중 abort) |

Job 간 스케줄러 격리(§9-3)는 채택하지 않았다: hang이 유한해지면 head-of-line blocking은 최대 deadline+grace(기본 ~55초)짜리 일시 지연으로 축소되고, 격리는 사이트당 동시 페이지 수를 늘려 block 위험을 키우기 때문이다.
