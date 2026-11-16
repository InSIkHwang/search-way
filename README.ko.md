# search-way

[English](README.md) | **한국어**

Google 항공편과 네이버 항공권에서 날짜를 유연하게 조합해 왕복 직항 항공권을 비교하는 로컬 MCP 서버입니다. 여러 출발일과 여행 기간을 검색하고 진행 상태를 조회한 뒤 원화 가격과 검색 링크를 받을 수 있습니다.

[npm 패키지](https://www.npmjs.com/package/search-way) · [소스 코드](https://github.com/InSIkHwang/search-way) · [ISC 라이선스](LICENSE)

## 설치

Node.js 20 이상인 지원 중 LTS 버전을 설치합니다. 배포된 패키지를 사용할 때는 Git 복제나 소스 빌드가 필요하지 않습니다.

```bash
npx -y search-way@1.0.0 setup
```

Google 항공편 검색용 Playwright Chromium을 준비하고, 네이버 검색용 Google Chrome이 없을 때만 설치합니다. Chrome 설치에는 관리자 권한이 필요할 수 있습니다. Linux에서는 `setup --with-deps`로 시스템 라이브러리도 설치할 수 있습니다. Windows PowerShell 실행 정책에 막히면 `npx` 대신 `npx.cmd`를 사용합니다.

설치 완료 후 출력되는 JSON을 사용하는 앱의 MCP 설정에 추가하고 다시 연결합니다. 앱이 서버를 자동으로 실행하므로 별도 터미널을 계속 켜 둘 필요는 없습니다.

### Windows MCP 설정

```json
{
  "mcpServers": {
    "search-way": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "search-way@1.0.0"]
    }
  }
}
```

### macOS / Linux MCP 설정

```json
{
  "mcpServers": {
    "search-way": {
      "command": "npx",
      "args": ["-y", "search-way@1.0.0"]
    }
  }
}
```

설정 형식이 다른 앱에서는 같은 명령과 인수를 등록합니다. **stdio 방식**으로 연결하며 원격 HTTP 주소나 search-way API 키는 필요하지 않습니다. 실제 검색은 MCP 서버를 실행하는 컴퓨터에서 수행합니다.

## 명령어

| 명령 | 설명 |
| --- | --- |
| `npx -y search-way@1.0.0` | MCP 서버 실행. 보통 MCP 앱이 자동 호출 |
| `npx -y search-way@1.0.0 setup` | 검색용 브라우저 설치 및 확인 |
| `npx -y search-way@1.0.0 setup --with-deps` | Linux 시스템 라이브러리까지 설치 |
| `npx -y search-way@1.0.0 config` | 현재 운영체제용 MCP 설정 출력 |
| `npx -y search-way@1.0.0 --help` | 도움말 |
| `npx -y search-way@1.0.0 --version` | 패키지 버전 |

## 검색 방법

MCP를 연결한 앱에서 다음처럼 요청합니다.

> PUS→SGN, 2027년 3월 출발, 왕복 직항, 출발·귀국 포함 5일, 토·일 모두 포함해서 검색해 줘. 완료될 때까지 폴링하고 최저가 상위 10개 날짜와 링크를 정리해 줘.

1. `start_flexible_search`로 검색을 시작하고 `job_id`를 받습니다.
2. 같은 ID로 `get_search_status`를 반복 호출합니다. 시작 간격은 20초 정도가 적당하며, `completed`, `failed`, `cancelled` 중 하나가 되면 종료합니다.
3. 중단하려면 같은 ID로 `cancel_search`를 호출합니다. 이미 완료된 부분 결과는 유지됩니다.

`start_flexible_search` 입력 예시:

```json
{
  "origin": "PUS",
  "destination": "SGN",
  "months": ["2027-03"],
  "min_trip_days": 5,
  "max_trip_days": 5,
  "departure_weekdays": [3, 4, 5, 6],
  "return_weekdays": []
}
```

| 입력 | 의미 |
| --- | --- |
| `origin`, `destination` | 공항 IATA 코드 3자리 |
| `months` | 출발 가능한 달 1~3개. `YYYY-MM` 형식이며 귀국일은 다음 달이어도 가능 |
| `min_trip_days`, `max_trip_days` | 출발일·귀국일을 포함한 여행 기간. 2~30일 |
| `departure_weekdays`, `return_weekdays` | `0`=일요일부터 `6`=토요일. 생략하거나 빈 배열이면 요일 제한 없음 |
| `airline` | 선택 항목. 제공처가 표시한 항공사 이름으로 필터링 |

5일 여행은 출발일로부터 4일 뒤 귀국합니다. 정확히 5일인 경우 수·목·금·토 출발에 토·일이 모두 포함되므로 위 예시에서는 `[3, 4, 5, 6]`을 사용합니다. 현재 검색 조건은 **성인 1명·일반석·왕복·직항·원화**로 고정돼 있습니다.

결과에는 진행률, 제공처별 오류, 날짜 조합, 제공처별 수집 최저가와 검색 URL을 가진 `best` 가격이 포함되며 가격순으로 정렬됩니다. 한쪽 제공처가 실패해도 다른 쪽 결과로 완료될 수 있으므로 완료 상태와 함께 오류 목록도 확인합니다.

## 설정과 데이터 저장

MCP 앱의 `env` 설정이나 셸 환경변수로 값을 변경합니다. `.env`는 **자동으로 읽지 않으며**, [.env.example](.env.example)은 설정값 참고용입니다.

| 환경변수 | 설치용 CLI 기본값 |
| --- | --- |
| `SEARCH_WAY_ALLOW_LIVE_NETWORK` | `1`. 실시간 검색 허용 |
| `SEARCH_WAY_NAVER_HEADLESS` | `1`. 네이버 브라우저 창을 표시하려면 `0` |
| `SEARCH_WAY_DATA_DIR` | 아래 운영체제별 사용자 폴더 |
| `SEARCH_WAY_PROVIDER_CONCURRENCY` | 서버 프로세스 내 전체 검색에 대해 제공처별 `6`. 범위 1~10 |
| `SEARCH_WAY_MIN_DELAY_MS` / `SEARCH_WAY_MAX_DELAY_MS` | `100` / `300` |
| `SEARCH_WAY_MAX_RETRIES` | `3`. 최초 호출 포함 최대 4회 |
| `SEARCH_WAY_RETRY_BASE_DELAY_MS` | `1000` |
| `SEARCH_WAY_REQUEST_TIMEOUT_MS` | `30000` |
| `SEARCH_WAY_TASK_DEADLINE_MS` | 요청 제한 시간 + `15000` |
| `SEARCH_WAY_TASK_KILL_GRACE_MS` | `10000` |
| `SEARCH_WAY_STALL_TIMEOUT_MS` | `600000` |

설치용 CLI는 패키지 폴더 밖에 검색 작업 JSON을 저장합니다.

| 운영체제 | 기본 경로 |
| --- | --- |
| Windows | `%LOCALAPPDATA%/search-way/jobs` |
| macOS | `~/Library/Application Support/search-way/jobs` |
| Linux | `$XDG_DATA_HOME/search-way/jobs`. 미설정 시 `~/.local/share/search-way/jobs` |

다른 위치를 사용하려면 `SEARCH_WAY_DATA_DIR`을 지정합니다. 서버를 재시작하면 진행 중이던 작업은 중단 처리되며 자동 재개되지 않습니다. 여러 서버 프로세스는 서로 다른 작업 폴더를 사용해야 합니다.

## 제한 사항과 문제 해결

- 수집한 검색 가격은 예약 확정 가격이 아닙니다. 반환된 링크에서 좌석, 수하물, 결제 조건을 확인합니다.
- 혼합 왕복편은 현재 양쪽 항공사가 같은 이름으로 표시될 수 있습니다. 카드 할인 조건도 MCP 결과에 포함되지 않으므로 원본 검색 결과에서 확인해야 합니다.
- 제공처별로 날짜 조합당 최저가 한 건을 반환합니다. 모든 항공편 조합을 제공하지 않으며 항공사 필터도 수집된 결과에 한정됩니다.
- 제공처 화면 변경, 호출 제한, CAPTCHA 등으로 부분 결과가 생길 수 있습니다. 브라우저가 없으면 `setup`을 다시 실행하고, 원인 확인 시 동시 실행 수를 낮추거나 `SEARCH_WAY_NAVER_HEADLESS=0`을 사용합니다.
- 개인 검색 용도로 사용하며 대량·상업적 수집은 피하고 제공처의 이용 조건을 준수합니다.

## 개발

```bash
git clone https://github.com/InSIkHwang/search-way.git
cd search-way
npm ci
npm run build
node dist/cli.js setup
```

| 명령 | 설명 |
| --- | --- |
| `node dist/cli.js` | 소스에서 설치용 CLI 실행 |
| `npm run dev:mcp` | 빌드 없이 TypeScript 서버 실행 |
| `npm run start:mcp` | 빌드된 서버 직접 실행 |
| `npm run typecheck` | 소스 타입 검사 |
| `npm test` | 전체 오프라인 테스트. stdio 테스트를 위해 빌드 선행 |
| `npm run test:unit` | 날짜 조합·오케스트레이터·작업 저장소 테스트 |
| `npm run test:providers` | 제공처 계약 테스트 |
| `npm run test:mcp` | MCP 테스트 |

서버 직접 실행 명령은 개발용 기본값을 사용합니다. 실시간 검색에는 `SEARCH_WAY_ALLOW_LIVE_NETWORK=1`, 네이버 headless 실행에는 `SEARCH_WAY_NAVER_HEADLESS=1`을 지정합니다. 기본 작업 폴더는 `./data/jobs`입니다. `node dist/cli.js`는 앞서 설명한 사용자용 기본값을 적용합니다. 테스트는 실제 제공처를 호출하지 않고 익명화 샘플과 임시 폴더를 사용합니다.

저장소는 구현 코드 `src/`, 회귀 테스트와 익명화 샘플 `tests/`, 제공처 진단과 샘플 출처를 확인하는 `scripts/spike-*.ts` 및 `docs/spikes/`로 구성됩니다. 실제 검색 데이터, 원본 캡처, 임시 파일, 빌드 결과와 배포 압축 파일은 Git에서 제외합니다. 새로 복제한 저장소에서도 테스트할 수 있도록 익명화 테스트 샘플은 유지합니다.

## npm 배포

새 릴리스에서는 패키지 버전과 두 README의 설치 명령에 고정된 버전을 함께 갱신합니다.

```bash
npm run typecheck
npm run build
npm test
npm pack --dry-run
npm login
npm publish --access public
npm view search-way version
```

`prepack`이 빌드를 자동 실행합니다. 배포 파일에는 `dist/`, 두 README, `LICENSE`, `package.json`만 포함되며 검색 기록과 임시 파일은 제외됩니다. 이미 배포된 `1.0.0`은 덮어쓸 수 없습니다.

게시 시 npm의 본인 인증을 완료해야 합니다. 승인 대기 상태라면 `npm stage list search-way`로 조회하고 검증한 항목을 `npm stage approve <stage-id>`로 승인합니다. 이 명령은 npm 11.15 이상, Node.js 22.14 이상에서 지원합니다. [npm 승인 대기 배포 안내](https://docs.npmjs.com/staged-publishing/)를 참고하고, 게시 후 실제 버전을 레지스트리에서 확인합니다.
