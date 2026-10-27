# Staging environment design

Actual local/remote execution evidence and remaining gates are recorded in
[the staging rehearsal](staging-rehearsal.md) and [release status](release-status.md).

The staging this document designs is deliberately modest: **one host, one
process pair (backend + frontend), one disposable PostgreSQL, one config
file** — the same shape the release evidence has been rehearsed on. Staging
exists to answer one question before production has to: *does this commit
boot, serve and survive its own rollback outside a developer's shell?* Nothing
in staging is long-lived, and nothing in staging holds production secrets.

**No paid resource is provisioned and no deployment happens without an
explicit owner decision** — this document is the plan and the checklist, and
`.env.staging.example` beside it is the shape of the staging configuration,
never a secret itself.

## Isolation

| Concern | Staging | Why |
| --- | --- | --- |
| Database | Dedicated disposable PostgreSQL database on its own port, **own credentials** (`buynotbuy_staging` role, app role without DDL rights after migrations) | The `DATABASE_URL` is the only credential the service holds (threat model T11); isolation of that one value isolates everything. Migrations run once via a separate privileged step, not by the app role |
| Secrets | Staging-only password, generated per staging install; never copied from production, never committed | A secret that exists in two environments protects neither |
| Data | Staging never imports production rows; its candle history is backfilled from public venue APIs exactly like a fresh install | Provenance (YAR-65) depends on being able to say which rows a result came from — a staging table with production rows in it cannot say that |
| Market config | The documented activation state (`docs/ethusdt-activation.md`) is rehearsed here **before** production, with the same two-line diff | Activation day becomes a re-run of a rehearsal instead of a first try |
| Network | Staging binds to loopback or a firewall-limited interface; the dashboard's origin is the only entry in `APP_CORS_ORIGINS` | CORS default is empty everywhere; staging states its origin explicitly rather than loosening production's |

## Health and readiness

Already built and tested; staging just points load balancing at them:

- `/healthz` — liveness only, plus `deploySha` when the deployment sets
  `DEPLOY_SHA`, which staging **always sets** (the pinned commit SHA), so a
  running instance can prove its own provenance;
- `/readyz` — database usable + provider state reported (provider state is
  not gating, by design);
- `/metrics` — Prometheus exposition; exempt from the rate limit alongside
  the other probes (`EXEMPT_PATHS`, checked against registered routes).

## Migration dry-run

Ordered, and every step records an exit code in the deployment log:

1. `npm ci` on the pinned SHA (lockfile install, clean tree).
2. `npm run build` — backend output is byte-reproducible (YAR-65); a staging
   build that differs from the recorded hash is a stop.
3. `db:migrate` against the staging database **before** the switch — schema
   reaches `MAX(version)`; a failure leaves the old instance serving the old
   schema untouched (migrations are a forward-only ledger; there is no
   automated rollback). Restore into a new database is described in
   [the disaster recovery runbook](disaster-recovery.md).
4. Boot with the staging env; read `registry_seeded` and one
   `market_venue_active` per configured market from the boot log.
5. `/readyz` until `ready`; then the smoke battery
   (`docs/ethusdt-activation.md` step 3 + error envelopes).

## Rollback rehearsal

Rehearsed, not merely written down:

- Code rollback = redeploy the previous pinned SHA from the release ledger
  (`ad71e73`, `efa9681`, …) — each carries green CI and a recorded verify.
- Config rollback = remove the activation lines from the staging env and
  restart (the ETHUSDT gate documents exactly this; rehearsed 24.10.2026:
  a boot without the activation settings returns to the documented single
  or primary-plus-observed state, and stored per-market rows survive for
  the next activation).
- Schema rollback = restore a verified snapshot into a new database paired with
  the compatible application version. Migrations provide no `down` steps;
  do not delete ledger entries or reverse DDL by hand. See
  [the disaster recovery runbook](disaster-recovery.md).

## Deployment checklist (the whole sequence)

- [ ] Owner decision recorded (SHA + environment)
- [ ] Clean checkout at the pinned SHA; `git diff` against the release
      ledger entry is empty
- [ ] `npm ci` → exit 0; `npm audit` clean (re-run, never inherited)
- [ ] `npm run build` → exit 0; backend dist hash matches the recorded one
- [ ] Staging database created; `db:migrate` → schema at latest
- [ ] Staging env in place from `.env.staging.example`, with
      `DEPLOY_SHA=<pinned sha>` set and **staging-only** DB credentials
- [ ] Boot; log shows `registry_seeded`, `market_venue_active` per market
- [ ] `/readyz` → `ready`; smoke battery green (frozen routes unchanged,
      per-market routes, error envelopes, 404 path)
- [ ] Observation window with provider metrics watched
      (freshness per market, cache hits/misses, no `market_venue_switched`
      surprises)
- [ ] Evidence posted: SHA, exit codes, probe outputs, timestamps
- [ ] Rollback path stated in the same evidence (previous SHA + env diff
      removal), ready to execute without preparation

## What staging cannot answer

Venue rate-limit headroom from a different network, latency profiles, and
anything else a dev host cannot speak for — those belong to the production
host itself (`docs/ethusdt-activation.md` records the same boundary), and
the load baseline is measured separately (YAR-75).
