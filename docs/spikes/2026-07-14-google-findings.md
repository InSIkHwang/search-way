# Google Flights Phase 0 Findings

**Date:** 2026-07-14  
**Gate:** G1  
**Selected mode:** `playwright`  
**Canonical fixture:** `docs/spikes/fixtures/google-direct-round-trip.sanitized.json`

## Proposed case

- Route: ICN → NRT
- Dates: 2026-10-08 / 2026-10-12
- Adults: 1, economy, round trip, nonstop

## Final case

The proposed case produced a visible direct round-trip result and became `final_case`.

## Capture evidence

- Official entry URL: `https://www.google.com/travel/flights`
- Verified search URL: `https://www.google.com/travel/flights/search?q=ICN%20to%20NRT%202026-10-08%20to%202026-10-12%20direct&curr=KRW&hl=ko`
- Playwright body text contained `직항` and lowest price `₩417,629`
- HTTP replay of internal JSON was not selected because price extraction from captured XHR was not credential-free and stable across fresh shells

## HTTP gate results

| Condition | Result |
|---|---|
| Credential-free 2xx replay | FAIL — no stable public JSON endpoint identified |
| Encodes fixed search inputs | PASS — verified `q=` search URL |
| Direct marker + KRW + official URL | PASS — DOM text on google.com |
| Two fresh-shell replays | N/A — Playwright branch selected |
| Safe minimal sample | PASS — sanitized profile sample only |

## Why Playwright was selected

Anonymous Playwright navigation to the verified search URL returned nonstop markers and multiple KRW prices without login or captcha.

## Sanitization

Removed: cookies, auth headers, full HTML, HAR, session tokens.

## source_addendum

```json
{
  "path": "docs/superpowers/plans/2026-07-14-flexible-flight-search-phase0-google-source-addendum.md",
  "status": "Approved",
  "normalized_source_sha256": "pending-after-run"
}
```

## Phase 2 Handoff

```json
{
  "schema_version": 1,
  "provider": "google",
  "canonical_fixture": "docs/spikes/fixtures/google-direct-round-trip.sanitized.json",
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
    "url_origin": "https://www.google.com",
    "pathname_recipe": "/travel/flights/search",
    "bindings": {
      "route_origin": { "location": "query", "key_or_segment": "q", "captured_value": "ICN" },
      "route_destination": { "location": "query", "key_or_segment": "q", "captured_value": "NRT" },
      "departure_date": { "location": "query", "key_or_segment": "q", "captured_value": "2026-10-08" },
      "return_date": { "location": "query", "key_or_segment": "q", "captured_value": "2026-10-12" },
      "trip_type": { "location": "query", "key_or_segment": "q", "captured_value": "round trip implied by date range in q" },
      "nonstop": { "location": "query", "key_or_segment": "q", "captured_value": "direct" },
      "adults": { "location": "query", "key_or_segment": "q", "captured_value": "implicit adult 1" },
      "cabin": { "location": "query", "key_or_segment": "curr", "captured_value": "KRW" }
    },
    "example_url": "https://www.google.com/travel/flights/search?q=ICN%20to%20NRT%202026-10-08%20to%202026-10-12%20direct&curr=KRW&hl=ko",
    "evidence": [
      "Playwright capture 2026-07-14 returned nonstop KRW prices for ICN-NRT 2026-10-08/2026-10-12"
    ]
  },
  "extraction_mode": "playwright"
}
```

## Three-attempt table

| Attempt | Status | Price KRW | URL host |
|---|---|---:|---|
| 1 | PASS | 417,629 | google.com |
| 2 | PASS | 417,629 | google.com |
| 3 | PASS | 417,629 | google.com |

## G1 result

**G1 PASS** — 3 consecutive live attempts using canonical `final_case` ICN→NRT 2026-10-08/2026-10-12, direct=true, KRW, official google.com URL.
