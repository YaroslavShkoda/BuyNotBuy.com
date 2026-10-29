# Remaining Linear tasks implementation plan

> **For agentic workers:** Use superpowers:executing-plans for the coordinating work and independent domain agents for disjoint scopes. Preserve every existing local change.

**Goal:** Prepare and verify all remaining BuyNotBuy.com Linear deliverables; distinguish implemented work, actual environment evidence and owner decisions.

**Architecture:** Keep financial algorithms intact. Add validation around existing contracts, truthful frontend metadata and reproducible browser/operational checks. Record a versioned release matrix rather than infer deployed state from source defaults.

**Tech Stack:** Next.js 16.4.2, Fastify 5, PostgreSQL 18, TypeScript, Vitest, Playwright.

**Spec:** Existing Linear YAR-77/78/79/81/82/83/84/85/86 descriptions, read 25.10.2026. User requested execution of every task without another planning round.

## Global constraints

- Base SHA `18e0034a407c0e6b7281efd0549e8dd09f3eb46d`; preserve uncommitted YAR-77.
- Read installed Next.js documentation before framework changes.
- No production activation, paid provisioning, commit/push/merge/deploy without explicit owner authorization.
- Mock/public research data only; do not read or print secrets.
- Independent read-only review for data/security work. No Done status without objective evidence.

## Review focus

- A pseudo-provider must never be published as the physical venue.
- Stale bars, cache age and analysis creation time have different meanings.
- Historical fixtures cannot count as prospective registration or prove calibration.
- Empty CI results and unknown remote environments must remain unknown.
- Browser metrics must identify lab conditions, interaction coverage and missing INP.

## Execution scopes

### YAR-82 — historical integrity

- [x] Inspect existing provider/ingestion/backfill contracts; write failing attribution and concurrency tests.
- [x] Add minimal attributed-history contract with legacy compatibility, report and per-series gate.
- [x] Verify synthetic cross-market failures, duplicate/restart and read-only inventory; record limitations.

Owned files: backend history/providers and their tests, `docs/historical-integrity-gate.md`.

### YAR-83 — CI security

- [x] Write synthetic audit-policy failure/expiry tests and limiter-store failure/recovery checks.
- [x] Implement runtime high/critical gate, bounded instrumentation and documented fail-open policy.
- [x] Pin Actions to verified revisions; integrate browser CI job after runner exists.
- [x] Run full/runtime audits and targeted tests; independent review.

Owned files: security tooling/tests, CI workflow, `docs/security-ci.md`.

### YAR-78 / YAR-81 — explanations and browser evidence

- [x] Pin actual API metadata semantics in tests, add same-snapshot additive metadata and readable Russian explanations.
- [x] Add real browser runner backed by local mocked SSR API; exercise activation, error, stale and accessible chart paths.
- [x] Collect lab LCP/CLS/interaction evidence, screenshots and explicit budgets; report INP limitations honestly.
- [x] Verify frontend component tests and browser runner; send CI job to CI scope owner.

Owned files: app, analysis DTO/controller metadata, e2e runner, browser/performance docs. Coordinator owns dependency changes.

### YAR-84 — prospective research protocol

- [x] Inventory existing fixtures/provenance and existing holdout/calibration machinery.
- [x] Freeze a new prospective protocol, costs, family correction, sample planning and stopping/negative-result rules.
- [x] Produce reproducible SHA inventory and readiness result; historical data must return INCONCLUSIVE, never fabricated future evidence.

Owned files: new protocol/evidence modules/tests and `docs/research-protocol.md`.

### YAR-86 — release documentation

- [x] Build a versioned environment matrix from actual evidence and unknowns.
- [x] Mark Stage4 acceptance and old activation/performance statements historical.
- [x] Add automatic path/link/SHA/matrix consistency checks with negative cases.

Owned files: release status/matrix/checker and historical document notices.

### YAR-85 / YAR-79 — integrated operations and decision

- [x] Inspect available target configuration without credentials; run disposable local migration/backend/frontend smoke and failover rehearsal.
- [x] Record actual vs simulated rollback/alerts/DNS/TLS evidence, leaving remote checks NOT_TESTED where unavailable.
- [x] Run combined lint/typechecks/tests/build/browser/security gates after integration.
- [x] Independent review, fix findings, update all existing Linear cards with precise results.
- [x] Publish local conditional GO/NO-GO recommendation for owner acceptance; no automatic production release.

Owned files: `docs/staging-rehearsal.md`, final release status and acceptance evidence.

## Execution result — 26.10.2026

Local plan steps completed. Full verify:285 files/5548 tests PASS; compiled backend and real browser integration PASS. Remote staging is absent (owner confirmed), so external gates for YAR-85 and final owner release YAR-79 remain open. Other deliverables are prepared for review, not marked Done or deployed.

Ruling: release tooling belongs in the existing research composition layer, and inventory SQL in the existing candle repository; architecture guards remain unchanged.
