# search-way

Flexible round-trip flight search across Google Flights and Naver Flights with an MCP stdio server.

## Setup

Requires Node.js 20+.

```bash
npm ci
cp .env.example .env
npm run build
```

## Offline development

```bash
npm test
npm run typecheck
```

Provider contract tests use sanitized HTML fixtures only. MCP stdio smoke runs the built server with `SEARCH_WAY_OFFLINE_SMOKE=1` and a temporary data directory.

## MCP server

```bash
SEARCH_WAY_DATA_DIR=./data/jobs npm run start:mcp
```

Tools:

- `start_flexible_search`
- `get_search_status`
- `cancel_search`

## Production defaults

- Source concurrency: `5` globally per source across all jobs (`SEARCH_WAY_PROVIDER_CONCURRENCY`, clamped to 1–6; measured optimum — 6 showed no further speedup)
- Polite delay: `500–1500ms`
- Transient retries: `3` (4 total attempts including the first call)
- Exponential retry base: `1000ms`
- Request timeout: `30000ms`
- One shared browser per source; each search gets a fresh isolated context (relaunches automatically if the browser disconnects)
- Result readiness polling: `1s` interval, ~2 minute budget, stability-based settle (returns once two consecutive reads are identical)

Concurrency `5` is global per source across all jobs, not per job.

Observed HTTP `429` pauses the affected source scheduler for all jobs and honors `Retry-After` when present. The other source continues. DOM-only CAPTCHA/interstitial, `403`, and `no_direct_flight` are permanent errors without synthesized status metadata.

URL improvement is source-specific. Without an exact Phase 0 recipe, the Phase 2 parser's validated official URL is retained. Do not guess URLs.

A process restart marks queued/running jobs as `failed/interrupted` and does not auto-resume.

Disk/store failure triggers one best-effort `failed/store_error` persistence. If that write also fails, `waitForIdle` returns the runtime error and the last durable snapshot may still show its earlier status.

Partial successful results remain valid when individual cells fail. Booking price and conditions must be rechecked at the returned URL.

Personal use only. Use an honest User-Agent, do not share credentials, and do not run bulk or commercial scraping.

## CI

```bash
npm run typecheck
npm test
npm run build
```

None of these commands make a live provider request.

## Live browser access

Manual live runs only:

```bash
SEARCH_WAY_ALLOW_LIVE_NETWORK=1 npm run spike:google -- --profile docs/spikes/fixtures/google-direct-round-trip.sanitized.json --attempt 1
SEARCH_WAY_ALLOW_LIVE_NETWORK=1 npm run spike:naver -- --profile docs/spikes/fixtures/naver-direct-round-trip.sanitized.json --attempt 1
```

Naver runs on the real Chrome binary (`channel: chrome`) in both modes. With
`SEARCH_WAY_NAVER_HEADLESS=1` it uses Chrome's new headless mode with the
`HeadlessChrome` UA token sanitized to `Chrome` — Naver withholds flight
results (the `searchFlights` API call never fires) when that token is present,
and Playwright's bundled Chromium headless shell is blocked even with a
sanitized UA (verified live 2026-07-16, 3/3 passes, ~6-7s to ready). Set
`SEARCH_WAY_NAVER_HEADLESS=0` to fall back to a visible headed Chrome window
if Naver tightens detection again.

## Project layout

- `src/domain` — date combinator and shared request types
- `src/orchestrator` — job scheduling, merge, cancellation, retry/backoff
- `src/jobs` — atomic JSON job store
- `src/providers/google`, `src/providers/naver` — Playwright clients and parsers
- `src/mcp` — validation, serialization, tool handlers, stdio server
- `src/config` — runtime environment parsing
- `docs/spikes` — Phase 0 feasibility findings and sanitized capture profiles
# search-way
