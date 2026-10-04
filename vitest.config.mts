import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Measured, not chosen (round 112): every test file's beforeAll runs
        // CREATE SCHEMA plus applyMigrations under one shared advisory lock,
        // and ~250 parallel files queue on it. The migration itself is ~3ms on
        // a migrated database (round 60) — the wait is the queue. Three full
        // runs: beforeAll median ~0.5s, p95 ~2s, worst 6.3s against the 10s
        // default, so a loaded machine turns tail latency into a red run. The
        // budget exists to be exceeded loudly, not to be lived in: 30s still
        // fails a genuinely hung migration, while ordinary contention no
        // longer fails the run.
        hookTimeout: 30_000,

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
