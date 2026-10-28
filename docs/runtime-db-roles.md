# Runtime database roles — YAR-89 laboratory

This gate uses only synthetic mock data and a separate PostgreSQL 18 cluster listening on `127.0.0.1:55489`. It never loads `.env`, changes an existing database, publishes anything or writes to Linear. Real deployment role changes and the YAR-85 rollout remain NOT_TESTED.

## Repeat the gate

From the repository root on Windows, with PostgreSQL 18 binaries at `C:/Program Files/PostgreSQL/18/bin`:

```powershell
node node_modules/typescript-5/bin/tsc -p src/backend/tsconfig.build.json --outDir data/next-gates/roles89/dist
node scripts/runtime-roles/lab.mjs
node scripts/runtime-roles/audit.mjs
node scripts/runtime-roles/dispose.mjs
```

The lab refuses an existing `data/next-gates/roles89/cluster`. For another run, keep the existing evidence, run the disposal script, and rename that verified stopped cluster directory before repeating. Disposal checks the server's actual data directory and port, checks the exact disposable database's owner, drops only `yar89_disposable`, then stops only that cluster. It performs no filesystem deletion. Loopback trust authentication is a disposable lab convenience, not a production authentication recommendation. There are no passwords in the scripts or evidence.

Generated `results.json`, `grants.json`, `effective-audit.json`, `green-handoff.json`, command logs, source/compiled hashes and `disposal.json` remain in the ignored laboratory directory. `results.json` records command exit codes and individual assertions; failure exits nonzero and cleans up the backend/client processes while leaving the lab cluster available for inspection. These generated local results do not independently establish the identity of a later candidate: compare the recorded source hashes to the frozen candidate being reviewed.

## Separation and SQL inventory

Admin bootstraps the database and two login roles. `yar89_migrator` owns the database/schema/application objects and applies the real compiled migration CLI as a separate process. The original f11 laboratory applied v25; the YAR-94 candidate adds real migration026. Every replay must record its own compiled source hashes and actual ledger; the historical v25 result does not certify v26. `yar89_runtime` owns no application objects and has no memberships. Both roles are NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and NOBYPASSRLS. Runtime receives database CONNECT and schema USAGE; PUBLIC database CREATE/TEMP and schema CREATE are revoked.

The application boot calls `currentSchemaVersion`, not `applyMigrations`. Registry seeding is DML, so an HTTP read API still needs a writing DB role. The explicit table grant manifest is in `scripts/runtime-roles/lab.mjs`; the effective ACL audit checks what PostgreSQL actually installed.

| Surface | Runtime rights and reason |
| --- | --- |
| `schema_migrations` | SELECT only for boot/readiness; no INSERT/UPDATE/DELETE/TRUNCATE |
| `asset`, `instrument` | SELECT/INSERT/UPDATE for configured registry seeding and classification |
| `market_candles` | SELECT/INSERT/UPDATE for ingestion; closed bars cannot reopen, while closed-to-closed revisions remain possible |
| `signal_history` | SELECT/INSERT/UPDATE/DELETE for recording and existing bounded-history trim |
| `indicator_vote`, `signal_transition` | Repository SELECT/INSERT/UPDATE plus retention DELETE |
| `signal_snapshot`, `signal_state`, `signal_outcome`, `strategy_version`, `signal_strategy_version`, `strategy_decision_log` | Explicit SELECT/INSERT/UPDATE required by runtime repositories |
| `retention_policy`, `index_audit`, `holdout_verdict` | SELECT only; their administrative writes are outside runtime duties |
| `retention_run` | SELECT/INSERT for pruning evidence |
| `rate_limit_window` | SELECT/INSERT/UPDATE for limiter counters; DELETE for expired-window retention |
| Sequences | USAGE only on existing sequences whose tables are explicitly granted INSERT; no setval/UPDATE |
| Functions | EXECUTE only on existing `set_market_row_instrument_id()` invoker trigger; it also needs runtime SELECT on `instrument` |
| Advisory lease | Built-in advisory lock acquisition, non-reentrant verification via current-session `pg_locks`, one explicit unlock |

Existing function EXECUTE is revoked from PUBLIC. The migrator's **global** default privileges revoke PUBLIC EXECUTE on future functions; a schema-scoped default REVOKE alone cannot remove PostgreSQL's global function default. No future table/sequence grants are automatic. A later synthetic DDL step creates a new identity table and function, proves initial access denial, grants only reviewed SELECT/INSERT/sequence USAGE, and proves UPDATE/ALTER remain denied. This fixture does not add an application migration; the log records the actual application ledger separately. In the original f11 replay its max/count was25/25. Migration026 is the separate real confidence-storage change, with its own tests and deployment approval requirements.

The negative probes connect as the actual runtime role and require SQLSTATE 42501 for CREATE TABLE/SCHEMA/TEMP, ALTER, DROP, ledger writes/TRUNCATE, SET ROLE to owner/admin, CREATE ROLE, role grants and sequence setval. No object ownership is given to runtime to make a failing test pass.

## Time budgets and recovery

Provisional runtime role defaults are `statement_timeout=5s` and `lock_timeout=500ms`. The existing pool adds startup options which override role defaults, so the runtime process also explicitly sets `DB_STATEMENT_TIMEOUT_MS=5000` and `DB_LOCK_TIMEOUT_MS=500`. Audit reads settings back through the actual compiled pool. These user-settable GUCs are operational limits, not immutable protection against arbitrary SQL execution.

The separate migrator process uses 120000ms/30000ms, while its raw role defaults remain 0/0. Runtime short budgets are not inherited by the migration role.

Initial synthetic measurements: 100 normal indexed reads p50 0.305ms, p95 0.485ms, maximum 1.778ms; mock market analysis roughly 3–12ms and retention roughly 20ms. Those measurements support generous lab headroom for the provisional budgets, not a production-load claim. The gate forces pg_sleep(10) to cancel with 57014 around 5s and an actual contended table lock to cancel with 55P03 around 500ms, then requires successful subsequent queries. Audit captures actual pg_stat_activity `PgSleep` and verifies successful reuse of the same borrowed connection after cancellation.

The original frozen backend crashed with unhandled Client error 57P01 when the lab terminated its database sessions. The lifecycle fix observes errors on the lease's borrowed client before its first query, clears held state immediately, retires each broken session once and reacquires on the next check. An idle pool error now produces only a fixed sanitized diagnostic. Transactions also observe their checked-out client throughout the callback, reject a transaction whose connection died between queries, preserve an original callback error and retire the broken connection once. Audit terminates an actual runtime transaction during a callback gap and requires 57P01 rejection followed by a successful new query. Lease verification checks `pg_locks` instead of repeatedly acquiring the reentrant advisory lock, so one unlock really releases leadership. Unit tests cover acquisition/verification/unlock races; a real test uses distinct PostgreSQL sessions to prove handoff after repeated checks.

The full gate starts the actual compiled server under runtime credentials and requires health/readiness HTTP 200, market and registry reads, actual candle/signal/snapshot/vote/strategy writes, retention/limiter rows, lease acquisition, real lock-failed durable spool write and replay by a fresh backend process. It then terminates only its own lab backend sessions and requires the **same backend PID** to survive, serve readiness and reacquire its lease. Synthetic provider freshness diagnostics are retained; a 200 readiness response is not evidence of a real provider deployment.

The transaction regression added two failing tests before its fix (RED 2 failed / 16 passed), then passed all 18 focused unit tests (GREEN). `scripts/runtime-roles/audit.mjs` is the portable actual-runtime-role replay of the callback-gap termination and replacement-connection query; it also runs a migrator query longer than the runtime's 5s budget.

YAR-90 fixes a pre-existing data-loss defect found by this gate: `signal_history.hour_bucket` is an epoch-hour identity, while retention cutoffs are milliseconds. The default policy now prunes by the real millisecond `timestamp`; keepDays and protected-table rules are unchanged. Existing stored policies read their time column from the code seed, so no schema migration is needed. Regression tests use the real repository to write fresh, expired, exact-cutoff and cutoff+1ms rows, both with a default policy and an existing stored keepDays override. They failed before the fix (both cases deleted all four rows) and then passed, deleting only the expired row. The portable audit repeats the real default prune under the restricted runtime role inside BEGIN/ROLLBACK; the full backend lab also requires its replayed history row to survive the actual retention cycle. Historical v2 results and its defect reproduction do not establish acceptance of the new candidate.

Independent read-only review of the SQL/grants and lifecycle delta is required before YAR-89 is accepted. External deployment roles, grant restoration in a real environment, production load/data and real providers remain NOT_TESTED.
