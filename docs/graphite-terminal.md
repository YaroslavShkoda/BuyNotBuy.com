# Graphite terminal — YAR-103–106

Implemented on the owner-selected Graphite design, stacked on PR22 (`d3a2a4a62264c9ca243f9b99f76f10aae9d5e087`), itself stacked on draft PR21 (`efbf668e40e8e265d60a7b38d48507d4d9810c30`). Verified application source commit: `dc2cb37c719ce71b5a684f0f86e7efe86692914d`; final documentation commit is identified by the pull request. No merge or deployment.

## Result

- Compact market heading, native-size layout without CSS zoom, chart before signal on narrow viewports, blue EMA/interaction accents.
- Separate API-provided chart/analysis source, bar-close, age and freshness strips. Unknown metadata remains unknown; page creation time does not claim fresh market data.
- Primary EMA/Momentum/Stochastic explanations remain visible. Secondary context measurements use a native disclosure; the reasons/limitations anchor retains confidence wording.
- Keyboard Escape restores the market-picker button. The chart table has a named, focusable bounded scrolling region. All critical controls offer 44px targets.
- Reduced motion disables animations and transitions; normal feedback uses the shared bounded transition tokens. No new dependency or font request.

API schemas, provider calls, financial math, indicator values/units, chart scale computation, confidence calculation and published direction were not changed. The visual change does not authorize trading, new markets or migration/deployment.

## Evidence

Windows, Node24.21.0, PostgreSQL18.4, Chromium156.0.8078.4; deterministic HTTP fixture, no exchange access. Disposable loopback PostgreSQL55529/private per-file schemas were used for tests, never the working database.

| Check | Result |
| --- | --- |
| Fresh frontend tests | PASS:19 files/152 tests, including3 snapshot tests |
| Lint, frontend/backend types | PASS, exit0 |
| Standalone e2e TypeScript5 check | PASS, exit0 |
| Frontend production + backend build | PASS, exit0 |
| Browser core scenarios | PASS:18, BTC/ETH/intervals/stale/insufficient/429/502/503/504/retry |
| Responsive/a11y matrix | PASS:360/390/768/1024/1440/1920;720CSSpx reflow proxy |
| Documentation paths/matrix, whitespace | PASS, exit0 |
| Independent whole-change read-only review | No Critical/Important findings; four minors below |
| Actual browser zoom, real AT/hardware, field RUM | NOT_TESTED |

Core browser checks additionally prove text/control/numeric container bounds and SVG/axis height agreement. Both assertions reproduced the defect before the correction. The responsive matrix proves chart-first order, no page overflow/CSS zoom, visible focus, Escape restoration, disclosures,44px controls and reduced-motion marker. It checks table focus/dimensions; keyboard scroll movement is not independently asserted.

The CI browser job enables `TERMINAL_AUDIT=1`; local output counts19 check entries because the seven-viewports matrix is one aggregate entry, plus18 core checks. This is not a claim of19 physical device tests.

Screenshots, accessibility snapshots, traces, failure reproductions and reports are under ignored local `data/graphite/`; selected before/after/state/comparison captures are attached to Linear. CI artifacts have their normal workflow retention. `design-qa.md` records visual scope and deviations; `docs/graphite-manual-acceptance.md` is the deferred real-device checklist.

## Performance

Canonical baseline and candidate ran serially on the same machine, with identical installed locked dependencies and no parallel tests/builds. One cold/warm sample per viewport, no throttling. Numbers are descriptive lab observations, not causal speed claims or field Core Web Vitals.

| Scenario | LCP before→after ms | CLS | INP candidate before→after ms | Interactive-ready before→after ms |
| --- | --- | --- | --- | --- |
| Desktop cold |256→216|0→0|48→32|1049→974|
| Desktop warm |156→120|0→0|32→32|878→838|
| Mobile emulation cold |200→160|0→0|40→40|860→908|
| Mobile emulation warm |100→88|0→0|40→40|762→764|

Static JS595181→595229 bytes(+48); CSS29202→29757(+555); decoded route JS457907→457955 bytes. Budgets: LCP4000ms, CLS0.1, observed interaction500ms, interactive readiness4000ms, route decoded JS1MB. All passed. Interactive readiness measures navigation-to-first functioning React picker, including `networkidle`; isolated React hydration profiler duration is not measured. INP is a short scripted Event Timing candidate. Baseline was rebuilt from exact `efbf668e` with shared exact dependencies; only test-side timing instrumentation was added in the ignored baseline copy.

Machine-readable comparison: `docs/graphite-performance.json`.

## Deferred review minors

1. Full ISO timestamps with milliseconds add mobile lines; compact visible UTC formatting could retain exact `dateTime`.
2. The reasons/limitations link targets provenance/limitations after the technical breakdown; an earlier technical anchor may be useful.
3. The matrix presses End but does not assert scroll movement when the table overflows.
4. The `.signal-value` CSS comment still describes removed flex growth.

The retained volume statistics and metadata make mobile taller than the raster concept. This scope implements its Graphite direction while retaining all research data; exact pixel replication is not claimed. Real-device AT remains owner-deferred on29 October: “Пока нет — оставить ручную проверку открытой”. YAR-97/78 remain open.
