# YAR-102 — Graphite design system

Base: PR21 `efbf668e40e8e265d60a7b38d48507d4d9810c30`. This change is stacked on the unmerged candidate, not main. Owner selected Graphite in YAR-101 on 28 October 2026. Terminal composition remains YAR-103.

Changes: opaque Graphite surfaces, semantic colours, readable 14px captions, shared type/focus/radius/motion tokens, removed backdrop blur and decorative background layers. Native system fonts avoid remote loads. Existing market values, API, React components and financial calculations are unchanged. Interval selection uses the blue interaction accent rather than a positive market colour.

Independent read-only review found two Important typography regressions: overlapping volume labels and clipped chart header. Auto-fitting volume tracks/wrapping and a wrapping chart heading fix these. New browser DOM-range assertions reproduced clipped content before the correction and pass after it. Prior failure is preserved under local `data/graphite/regression-red`.

Verified on Windows, Node24.21.0, PostgreSQL18.4, Chromium fixture (no market network):

- `npm ci --ignore-scripts`: exit0, 132 packages, audit0 vulnerabilities. Existing package-lock unchanged.
- `npm run lint`, `npm run typecheck`, `npm run typecheck:backend`: exit0.
- `npm run build`: exit0, frontend production and compiled backend.
- `npm test -- src/app --maxWorkers=2`: exit0, 18 files / 149 tests. Own loopback PG55529, new test database and private per-file schemas; no working DB access.
- `npm run browser:e2e`: exit0, 18 checks both before and after. Covers BTC/ETH, intervals, keyboard/touch emulation, chart table, stale, insufficient history, 429/502/503/504 and retry; adds numeric/control/label clipping assertion.
- `git diff --check`: exit0.

Before/after screenshots and reports are stored in local ignored `data/graphite/before` and `data/graphite/system-final`; selected screenshots attached to Linear. These deterministic fixtures are lab evidence, not actual exchange prices or field Core Web Vitals. Solid palette muted/floating ratio6.23:1 and hover4.56:1 independently reviewed; this is not full WCAG certification.

Known existing constraints for subsequent tasks: CSS zoom1.30, signal-first mobile order and oversized asset masthead (103/104); infinite marker animation under reduced motion (105). Full redesign visual acceptance is not claimed by this design-system PR. Real NVDA/VoiceOver, hardware touch, production data and external staging NOT_TESTED. No merge/deploy/activation.
