# search-way

**English** | [한국어](README.ko.md)

A local MCP server for flexible, nonstop round-trip flight searches across Google Flights and Naver Flights. Compare departure dates and trip lengths, poll progress, and receive prices in KRW with search links.

[npm package](https://www.npmjs.com/package/search-way) · [Source](https://github.com/InSIkHwang/search-way) · [ISC license](LICENSE)

## Installation

Install a supported Node.js LTS release, version 20 or later. No Git checkout or source build is required to use the published package.

```bash
npx -y search-way@1.0.0 setup
```

Setup prepares Playwright Chromium for Google Flights, checks Google Chrome for Naver Flights, and installs Chrome only when it is missing. Chrome installation may require administrator privileges. On Linux, use `setup --with-deps` to also install system libraries. In Windows PowerShell, use `npx.cmd` if the execution policy blocks `npx`.

Add the JSON printed by setup to your MCP client's configuration, then reconnect the client. The client starts the server automatically; a separate terminal does not need to stay open.

### Windows MCP configuration

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

### macOS / Linux MCP configuration

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

For clients with another configuration format, use the same command and arguments. The server uses **stdio**, not a remote HTTP endpoint. A search-way API key is not required; searches run on the computer running the MCP server.

## Commands

| Command | Purpose |
| --- | --- |
| `npx -y search-way@1.0.0` | Start the MCP server; normally launched by your MCP client |
| `npx -y search-way@1.0.0 setup` | Install and check browser dependencies |
| `npx -y search-way@1.0.0 setup --with-deps` | Also install Linux system dependencies |
| `npx -y search-way@1.0.0 config` | Print MCP configuration for the current operating system |
| `npx -y search-way@1.0.0 --help` | Show help |
| `npx -y search-way@1.0.0 --version` | Show the package version |

## Searching

Example request to your MCP client:

> Search PUS to SGN for nonstop round trips departing in March 2027. Trips must last five calendar days and include both Saturday and Sunday. Poll until complete, then show the ten cheapest dates with links.

1. Call `start_flexible_search` to receive a `job_id`.
2. Poll `get_search_status` with that ID until the status is `completed`, `failed`, or `cancelled`. A 20-second interval is a reasonable starting point.
3. Call `cancel_search` with the same ID to stop a search. Completed partial results are preserved.

Example `start_flexible_search` input:

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

| Input | Meaning |
| --- | --- |
| `origin`, `destination` | Three-letter airport IATA codes |
| `months` | One to three departure months in `YYYY-MM` format; returns may fall in a later month |
| `min_trip_days`, `max_trip_days` | Trip length from 2 to 30 days, including departure and return dates |
| `departure_weekdays`, `return_weekdays` | `0` = Sunday through `6` = Saturday; omitted or empty arrays impose no restriction |
| `airline` | Optional airline-name filter matched against the provider's displayed airline name |

A five-day trip returns four calendar days after departure. For this exact duration, Wednesday through Saturday departures include both weekend days; `[3, 4, 5, 6]` is specific to this example. Searches currently use **one adult, economy, round trip, nonstop, KRW**.

Results include progress, per-provider errors, date pairs, each provider's lowest captured quote, and a `best` quote with a search URL. Results are sorted by price. Check errors even when a job completes: one provider can fail while the other returns a valid result.

## Configuration and local data

Set overrides in your MCP client's `env` configuration or shell environment. `.env` is **not loaded automatically**; [.env.example](.env.example) is a reference.

| Environment variable | CLI default |
| --- | --- |
| `SEARCH_WAY_ALLOW_LIVE_NETWORK` | `1`; allows live searches |
| `SEARCH_WAY_NAVER_HEADLESS` | `1`; use `0` to show the Naver browser |
| `SEARCH_WAY_DATA_DIR` | User data directory below |
| `SEARCH_WAY_PROVIDER_CONCURRENCY` | `6` per provider across jobs in one server process; range 1–10 |
| `SEARCH_WAY_MIN_DELAY_MS` / `SEARCH_WAY_MAX_DELAY_MS` | `100` / `300` |
| `SEARCH_WAY_MAX_RETRIES` | `3`; up to four attempts |
| `SEARCH_WAY_RETRY_BASE_DELAY_MS` | `1000` |
| `SEARCH_WAY_REQUEST_TIMEOUT_MS` | `30000` |
| `SEARCH_WAY_TASK_DEADLINE_MS` | Request timeout + `15000` |
| `SEARCH_WAY_TASK_KILL_GRACE_MS` | `10000` |
| `SEARCH_WAY_STALL_TIMEOUT_MS` | `600000` |

The installed CLI stores job JSON files outside the package directory:

| Platform | Default location |
| --- | --- |
| Windows | `%LOCALAPPDATA%/search-way/jobs` |
| macOS | `~/Library/Application Support/search-way/jobs` |
| Linux | `$XDG_DATA_HOME/search-way/jobs`, or `~/.local/share/search-way/jobs` |

Override the location with `SEARCH_WAY_DATA_DIR`. Restarting the server marks unfinished jobs as interrupted; searches do not resume automatically. Use separate job directories for separate server processes.

## Limitations and troubleshooting

- Search prices are not guaranteed booking prices. Recheck availability, baggage, and payment conditions at the returned link.
- Mixed-carrier round trips can currently report the same airline on both legs. Card-discount conditions are not returned by MCP; verify these details in the original results.
- Each provider returns one lowest quote per date pair, not every itinerary. The airline filter operates on captured results and may miss other combinations.
- Browser changes, rate limits, and CAPTCHA can cause partial results. Rerun `setup` for missing browsers; reduce concurrency or use `SEARCH_WAY_NAVER_HEADLESS=0` when diagnosing failures.
- Use this for personal searches. Avoid bulk or commercial scraping and follow the source sites' terms.

## Development

```bash
git clone https://github.com/InSIkHwang/search-way.git
cd search-way
npm ci
npm run build
node dist/cli.js setup
```

| Command | Purpose |
| --- | --- |
| `node dist/cli.js` | Run the installed-style CLI from source |
| `npm run dev:mcp` | Run the TypeScript server without building |
| `npm run start:mcp` | Run the built server directly |
| `npm run typecheck` | Type-check source |
| `npm test` | All offline tests; build first for stdio smoke tests |
| `npm run test:unit` | Domain, orchestrator, and job-store tests |
| `npm run test:providers` | Provider contract tests |
| `npm run test:mcp` | MCP tests |

Direct server commands use development defaults: set `SEARCH_WAY_ALLOW_LIVE_NETWORK=1` for live searches and `SEARCH_WAY_NAVER_HEADLESS=1` for headless Naver. Their default job directory is `./data/jobs`; `node dist/cli.js` applies the user-facing defaults above. Tests use sanitized fixtures and temporary directories without live provider requests.

The repository contains `src/` for implementation, `tests/` for regression tests and sanitized fixtures, and `scripts/spike-*.ts` plus `docs/spikes/` for provider diagnostics and fixture provenance. Runtime data, raw captures, temporary files, build output, and release archives are ignored by Git. Sanitized test fixtures remain versioned so tests work after a fresh clone.

## Publishing

For a new release, update the package version and pinned installation examples in both READMEs.

```bash
npm run typecheck
npm run build
npm test
npm pack --dry-run
npm login
npm publish --access public
npm view search-way version
```

`prepack` builds automatically. The package includes `dist/`, both READMEs, `LICENSE`, and `package.json`; search records and temporary files are excluded. Published version `1.0.0` cannot be overwritten.

Complete npm's authentication prompts. If a release is staged, inspect it with `npm stage list search-way`, then approve the verified item with `npm stage approve <stage-id>`. These commands require npm 11.15+ and Node.js 22.14+. See [npm's staged publishing guide](https://docs.npmjs.com/staged-publishing/). Verify the actual version in the registry after publishing.
