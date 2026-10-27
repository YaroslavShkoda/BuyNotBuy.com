# Browser verification

YAR-78 / YAR-81, 25 October 2026. Starting repository and origin/main SHA:
`18e0034a407c0e6b7281efd0549e8dd09f3eb46d`; results cover the local working
patch, not a published commit or deployment.

## Reproduce

```sh
npm ci
npx playwright install --with-deps chromium
npx next build
npm run browser:e2e
```

On Windows, `npx playwright install chromium` suffices. The runner requires a
production `.next` build and starts its own Next server and HTTP API fixture on
ephemeral loopback ports; no application server or market account is needed.
`BACKEND_URL` is overridden in the child process. It never writes `.env`, runs
trades, contacts a venue, or opens a database. Browser requests outside the local
Next origin are aborted. Fixtures are validated with the actual API schemas.
The test terminates its child processes in `finally`.

For a clean local evidence directory (PowerShell):

```powershell
$env:E2E_ARTIFACT_DIR = 'data/browser-e2e/final'
npm run browser:e2e
```

The default artifact directory is `data/browser-e2e` (git-ignored). Use a new
directory for each evidence run so screenshots from previous failures remain
distinguishable. JSON results, viewport and full-page screenshots, accessible
trees and Playwright traces are saved. Failure saves a screenshot, trace and
partial report. Artifacts contain synthetic public prices, no credentials.

## Automated coverage

18 checks run in Chromium across desktop 1440×1000 and touch mobile 390×844:

- Home redirect; actual rendered chart; keyboard Enter or touch opens its
  matching candle-table alternative; Russian document language; no page overflow.
- Active BTC→ETH switch via searchable control, instrument heading and all four
  intervals; inactive ETH disappears from options after registry reload.
- Stale response, backend diagnostic quality and displayed reason, source/venue,
  interval, bar close time, confidence model and research caveats.
- Insufficient-history state and recovery through a different interval.
- HTTP 429/502/503/504 error boundaries and successful retry after recovery.
- Cold browser-context navigation and same-context warm reload; real browser
  LCP, CLS and Event Timing interaction samples with budgets.

The error recovery scenario exposed the installed Next version's distinction
between `reset` and `retry`: `reset` only clears the boundary; `retry` re-fetches
the segment. The production UI now uses `retry`, as the installed Next guide
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`
requires. The unchanged E2E recovery assertion failed before this fix and passes
after it.

Component tests cover absent metadata, separate close time and response time,
bar age calculation, actual provider/freshness/model/diagnostic quality and readable research
limitations. API tests pin the same-response snapshot and explanation, including
a different venue and symbol. New API fields are optional for older payloads;
existing fields and signal calculations are unchanged. Volatile snapshot cache
age stays in existing HTTP headers, outside JSON, to preserve conditional GET.

## Scope of evidence

The deterministic suite verifies **browser → Next SSR → HTTP mock API**. An
additional opt-in integration smoke verifies the real application backend:

```powershell
$env:E2E_BACKEND_URL = 'http://127.0.0.1:3301'
$env:E2E_ARTIFACT_DIR = 'data/browser-e2e/real-backend'
node --import=tsx e2e/real-backend-smoke.ts
```

Provision the backend with a disposable PostgreSQL database, active BTC/ETH and
the explicit mock provider before running this command. The script refuses
non-loopback URLs and requires `snapshot.provider === 'mock'`, checks eight
actual market/analysis HTTP pairs (BTC/ETH × four intervals), then renders both
markets through a separate production Next process in Chromium. Local evidence
passed all eight pairs and both browser markets against the caller-provisioned
backend on port 3301 and disposable PostgreSQL on port 55477. Database setup and
mock-feed startup are owned by the staging drill; the smoke does not create or
change unknown databases. The regular CI browser job uses the deterministic
fixture, while actual database integration also runs in the disposable-schema
Vitest suite.

Neither suite proves live provider correctness, RUM, real mobile hardware, or
real screen-reader announcements. Do not mark those as verified from this report.
The fixture supplies a stale diagnostic assessment alongside LONG; it does not claim
that quality assessment gates publication. The backend computes diagnostic quality after publication; an unusable assessment can coexist with LONG/SHORT. No HOLD or quality veto is invented by the UI.

Manual review inspected the actual desktop/mobile screenshots and accessible
trees. A real assistive-technology pass (NVDA/VoiceOver), hardware touch check,
multiple browser engines and field telemetry remain release follow-ups.

Manual screenshot inspection also exposed mobile horizontal overflow from
desktop CSS zoom. The initial check against `window.innerWidth` could miss it
because the layout viewport grew with the overflow. The corrected assertion
compares document width with the configured 390 px viewport; it failed before
the mobile zoom fix. Mobile now uses zoom 1 and a normal 20 px page inset.
Primary mobile touch targets have explicit 44 px minimum dimensions, asserted
using actual browser bounding boxes; this check also failed before the fix.

## Latest local evidence

Production Next build: exit 0. Browser suite: exit 0, 18 checks. Chromium
156.0.8078.4, Playwright 1.64.1, Windows, Node 24.21.0. App component and analysis
route run: 19 files / 151 tests pass, exit 0. Scoped Biome: 73 files, exit 0.
Frontend and backend typechecks: exit 0. The runtime-reliability/adversarial API
run passed 26 tests but logged existing asynchronous writes after test-pool
closure; those warnings are not claimed as a clean log run.

CI job publishes `data/browser-e2e/` as an artifact even on failure. Local
execution is proven; there is no CI run URL for this unpushed patch.
