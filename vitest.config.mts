import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // A loud budget for a genuinely hung schema setup, not a lived-in one.
        //
        // History, measured rather than inherited: every test file's beforeAll
        // creates its own private schema and runs the full migration chain,
        // and until the private-schema migrations stopped taking the global
        // advisory lock (db/migrations.ts, skipAdvisoryLock), ~250 chains
        // serialized behind it — the last file waited for the whole queue,
        // ~40-120ms per chain, and under load the tail crossed 30s. That was
        // the one-file-per-run "Could not take the migration lock" flake: the
        // hook had a 60s budget since round 112, but the lock deadline inside
        // the chain is 30s and it threw first. With the lock skipped the chains
        // run in parallel and the tail is one chain; 60s stays so a genuinely
        // wedged migration still fails the run loudly instead of hanging it.
        hookTimeout: 60_000,

        // Isolation stays on, and that is measured, not inherited. With
        // `isolate: false` the scoped run went 59 files red out of 66 — 604
        // tests skipped. The setup file gives each test file its own schema by
        // rewriting `DATABASE_URL` before the dynamic imports run, but a
        // reused worker does not re-evaluate the pool module: the second file
        // keeps the first file's pool, whose schema the first file's `afterAll`
        // has already dropped. The few seconds vitest offers for disabling
        // isolation are paid for by the one thing this suite cannot give up:
        // per-file module state.

        // Order matters. The database has to be pointed at this file's own
        // schema before any module reads DATABASE_URL at import time, and the
        // network guard has to be in place before a test replaces fetch with
        // its own stub — a stub installed over the guard would quietly reopen
        // the network.
        setupFiles: [
            './src/backend/test-support/test-database.ts',
            './src/backend/test-support/no-network.ts',
        ],
    },
});
