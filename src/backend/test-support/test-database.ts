import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach } from 'vitest';

/**
 * Keeps every test run out of the real database.
 *
 * Several suites drive the real `analyzeMarket`, which records signal history
 * and indicator votes through process-wide singletons. Without this they write
 * fabricated readings — a mock price of 100 next to a mock close of 100000 —
 * into the real database, where they survive as rows that later look exactly
 * like measurements. A test must never leave evidence behind that a later run
 * has to tell apart from reality.
 *
 * Isolation is per *file*, by giving each one its own schema. Vitest runs test
 * files in parallel, so a shared table would let one file's rows answer another
 * file's assertions — and a `TRUNCATE` between tests would then delete the
 * rows a concurrently running file had just written. A schema per file makes
 * the tables private without giving up parallelism.
 *
 * The schema is applied through `search_path` in the connection string, which
 * is the database's own mechanism for it and not something the repositories
 * know about.
 */
const DEFAULT_TEST_DATABASE_URL =
    'postgresql://postgres@127.0.0.1:5432/buynotbuy_test';

const SCHEMA = `buynotbuy_test_${randomUUID().replace(/-/g, '')}`;

function withSearchPath(url: string, schema: string): string {
    const parsed = new URL(url);
    const carried = parsed.searchParams.get('options');

    const searchPath = `-c search_path=${schema}`;

    parsed.searchParams.set(
        'options',
        carried === null || carried === ''
            ? searchPath
            : `${carried} ${searchPath}`,
    );

    return parsed.toString();
}

// Assigned before anything reads it — and, crucially, before the database
// modules are imported below.
//
// `database.config.ts` parses the environment once, at module scope, and
// ESM hoists every static import above the body of this file. A plain
// `import { query } from '../db/pool.js'` would therefore be evaluated first:
// the config would capture the connection string *without* `search_path`, every
// test file would quietly share the default `public` schema, and the `TRUNCATE`
// in `beforeEach` would delete rows a concurrently running file had just
// written. The imports below are therefore dynamic, and awaited here.
process.env.DATABASE_URL = withSearchPath(
    process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
    SCHEMA,
);

const { closePool, query } = await import('../db/pool.js');
const { applyMigrations } = await import('../db/migrations.js');

beforeAll(async () => {
    await query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

    // The tables the service writes into are the tables the tests assert on,
    // so the schema has to be the one migrations run against.
    await applyMigrations();
});

/**
 * Empties the tables this file's tests write into.
 *
 * A test that leaves rows behind decides what the next test in the same file
 * sees. The schema makes that leak stop at the file boundary; this makes it
 * stop at the test boundary too.
 */
beforeEach(async () => {
    await query('TRUNCATE signal_history, indicator_vote');
});

afterAll(async () => {
    try {
        // Dropped before the pool closes: the pool's connections all carry this
        // file's search_path, so they are the cheapest way back to the server.
        await query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } catch {
        // A schema left behind in a throwaway test database costs nothing.
        // Failing a test because cleanup could not run would.
    }

    await closePool();
});
