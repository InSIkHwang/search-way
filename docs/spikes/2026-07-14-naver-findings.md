# Naver Flights Phase 0 Findings

**Date:** 2026-07-14  
**Gate:** G2  
**Selected mode:** `playwright`  
**Canonical fixture:** `docs/spikes/fixtures/naver-direct-round-trip.sanitized.json`

## Proposed case

- Route: ICN → NRT
- Dates: 2026-10-08 / 2026-10-12
- Adults: 1, economy, round trip, nonstop

## Final case

The proposed case produced visible direct round-trip results and became `final_case`.

## Capture evidence

- Official entry URL: `https://flight.naver.com/`
- Verified round-trip search URL: `https://flight.naver.com/flights/international/ICN:airport-NRT:airport-20261008/NRT:airport-ICN:airport-20261012?adult=1&isDirect=true&fareType=Y`
- Headed Chrome (`channel: chrome`, `headless: false`) body text contained `왕복`, `직항`, date markers `10.08.목` / `10.12.월`, and lowest direct round-trip price `367,388원`
- Direct HTTP POST to `flight-api.naver.com/flight/international/searchFlights` returned **503** without browser session

## HTTP gate results

| Condition | Result |
|---|---|
| Credential-free 2xx replay | FAIL — API returns 503 without browser session |
| Encodes fixed search inputs | PASS — verified airport-segment round-trip URL |
| Direct marker + KRW + official URL | PASS — DOM body text on flight.naver.com |
| Two fresh-shell replays | N/A — Playwright branch selected |
| Safe minimal sample | PASS — sanitized profile sample only |

## Why Playwright was selected

Anonymous headed Chrome navigation to the verified airport-segment round-trip URL returned nonstop markers and multiple KRW round-trip prices without login or captcha. Headless Chromium did not reliably load prices in this environment.

## URL recipe note

Round-trip requires the outbound/return airport path segments, not a single `ICN-NRT-YYYYMMDD-YYYYMMDD` slug:

`/flights/international/ICN:airport-NRT:airport-20261008/NRT:airport-ICN:airport-20261012`

## Sanitization

Removed: cookies, auth headers, full HTML, HAR, session tokens, API request bodies.

## Phase 2 Handoff

```json
{
  "schema_version": 1,
  "provider": "naver",
  "canonical_fixture": "docs/spikes/fixtures/naver-direct-round-trip.sanitized.json",
  "final_case": {
    "origin": "ICN",
    "destination": "NRT",
    "departure_date": "2026-10-08",
    "return_date": "2026-10-12",
    "adults": 1,
    "cabin": "economy",
    "trip_type": "round_trip",
    "nonstop": true
  },
  "url_recipe": {
    "status": "verified",
    "url_origin": "https://flight.naver.com",
    "pathname_recipe": "/flights/international/{origin}:airport-{destination}:airport-{departureYYYYMMDD}/{destination}:airport-{origin}:airport-{returnYYYYMMDD}",
    "bindings": {
      "origin": { "location": "path", "key_or_segment": "ICN:airport", "captured_value": "ICN" },
      "destination": { "location": "path", "key_or_segment": "NRT:airport", "captured_value": "NRT" },
      "departure_date": { "location": "path", "key_or_segment": "20261008", "captured_value": "2026-10-08" },
      "return_date": { "location": "path", "key_or_segment": "20261012", "captured_value": "2026-10-12" },
      "trip_type": { "location": "path", "key_or_segment": "outbound/return segments", "captured_value": "round_trip" },
      "nonstop": { "location": "query", "key_or_segment": "isDirect", "captured_value": "true" },
      "adults": { "location": "query", "key_or_segment": "adult", "captured_value": "1" },
      "cabin": { "location": "query", "key_or_segment": "fareType", "captured_value": "Y" }
    },
    "example_url": "https://flight.naver.com/flights/international/ICN:airport-NRT:airport-20261008/NRT:airport-ICN:airport-20261012?adult=1&isDirect=true&fareType=Y",
    "evidence": [
      "Headed Chrome capture 2026-07-14 returned nonstop KRW round-trip prices for ICN-NRT 2026-10-08/2026-10-12"
    ]
  },
  "extraction_mode": "playwright"
}
```

## Three-attempt table

| Attempt | Status | Price KRW | URL host |
|---|---|---:|---|
| 1 | PASS | 367,388 | flight.naver.com |
| 2 | PASS | 367,388 | flight.naver.com |
| 3 | PASS | 367,388 | flight.naver.com |

## G2 result

**G2 PASS** — 3 consecutive live attempts using canonical `final_case` ICN→NRT 2026-10-08/2026-10-12, direct=true, KRW, official flight.naver.com URL.
