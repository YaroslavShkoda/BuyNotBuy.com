import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
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

// The write spool is real disk state: enabled by default in production, it
// would have every failing-stub test fsync lines into `./data/spool` and every
// later file reload them at boot — durable state is exactly the thing that
// leaks *between* test files, which per-file schemas cannot isolate. The
// handful of files that test the spool itself turn it back on, before their
// own imports run, pointed at a directory they delete.
process.env.WRITE_SPOOL_ENABLED ??= 'false';

const { closePool, query, getPool } = await import('../db/pool.js');
const { applyMigrations } = await import('../db/migrations.js');

/**
 * The pool this file's tests use.
 *
 * Exported because a test that only truncates a table does not need the pool,
 * while a test that borrows a connection or runs a raw query does. Importing
 * `db/pool` from a test directly would grab a connection on the default search
 * path — the real schema — and truncate the wrong table.
 */
export function getTestPool(): Pool {
    return getPool();
}

/** Adds one valid canonical instrument to this test file's isolated schema. */
export async function seedTestInstrument(ticker: string): Promise<void> {
    const normalized = ticker.toUpperCase();
    const quote = ['USDT', 'USDC', 'USD', 'EUR', 'BTC'].find((suffix) =>
        normalized.endsWith(suffix),
    ) ?? 'USDT';
    const base = normalized.endsWith(quote)
        ? normalized.slice(0, -quote.length)
        : normalized;

    if (!/^[A-Z0-9]{2,12}$/.test(base) || base === quote) {
        throw new Error(`Test ticker cannot be represented as an instrument: ${ticker}`);
    }

    for (const symbol of [base, quote]) {
        await query(
            `INSERT INTO asset (symbol, category, status, source, decided_at)
             VALUES ($1, 'crypto', 'active', 'configured', 0)
             ON CONFLICT (symbol) DO NOTHING`,
            [symbol],
        );
    }

    await query(
        `INSERT INTO instrument (ticker, base_asset, quote_asset, market_kind)
         VALUES ($1, $2, $3, 'crypto')
         ON CONFLICT (ticker) DO NOTHING`,
        [normalized, base, quote],
    );
}

export async function truncateSignalTables(): Promise<void> {
    await query(
        // `signal_snapshot` was missing from this list, and a table that is not
        // truncated is not a gap a test can see: every other omission shows up
        // as a count that will not go back to zero, whereas this one let a file
        // accumulate rows against itself and still pass as long as each
        // assertion was written to tolerate the leftovers. Whether that is
        // harmless depends entirely on what the assertions happen to filter by.
        //
        // `strategy_version` is deliberately not here. It is reference data for
        // this table rather than something these tests produce, and emptying it
        // would break every file that resolves the active version in `beforeAll`.
        `TRUNCATE signal_history, indicator_vote, market_candles,
                  signal_transition, signal_state, signal_outcome,
                  strategy_decision_log, signal_strategy_version,
                  signal_snapshot`,
    );
}

beforeAll(async () => {
    await query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

    // The tables the service writes into are the tables the tests assert on,
    // so the schema has to be the one migrations run against.
    await applyMigrations();

    // Repository integration tests exercise persistence directly, without
    // booting the application that normally seeds this reference data. Keep a
    // small canonical test registry so the instrument foreign-key triggers
    // enforce the same invariant in tests as they do after application boot.
    const assets = [
        ['BTC', 'crypto'],
        ['ETH', 'crypto'],
        ['XRP', 'crypto'],
        ['SOL', 'crypto'],
        ['ADA', 'crypto'],
        ['DOGE', 'crypto'],
        ['USDT', 'crypto'],
        ['USDC', 'crypto'],
        ['USD', 'fiat'],
        ['EUR', 'fiat'],
        ['ZZZ', 'crypto'],
    ] as const;

    for (const [symbol, category] of assets) {
        await query(
            `INSERT INTO asset (symbol, category, status, source, decided_at)
             VALUES ($1, $2, 'active', 'configured', 0)
             ON CONFLICT (symbol) DO NOTHING`,
            [symbol, category],
        );
    }

    const instruments = [
        ['BTCUSDT', 'BTC', 'USDT', 'crypto'],
        ['ETHUSDT', 'ETH', 'USDT', 'crypto'],
        ['XRPUSDT', 'XRP', 'USDT', 'crypto'],
        ['SOLUSDT', 'SOL', 'USDT', 'crypto'],
        ['ADAUSDT', 'ADA', 'USDT', 'crypto'],
        ['DOGEUSDT', 'DOGE', 'USDT', 'crypto'],
        ['BTCUSDC', 'BTC', 'USDC', 'crypto'],
        ['ETHBTC', 'ETH', 'BTC', 'crypto'],
        ['XRPBTC', 'XRP', 'BTC', 'crypto'],
        ['BTCUSD', 'BTC', 'USD', 'fiat'],
        ['ETHUSD', 'ETH', 'USD', 'fiat'],
        ['EURUSD', 'EUR', 'USD', 'fiat'],
        ['ZZZUSD', 'ZZZ', 'USD', 'fiat'],
    ] as const;

    for (const [ticker, base, quote, marketKind] of instruments) {
        await query(
            `INSERT INTO instrument (ticker, base_asset, quote_asset, market_kind)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (ticker) DO NOTHING`,
            [ticker, base, quote, marketKind],
        );
    }
});

/**
 * Empties the tables this file's tests write into.
 *
 * A test that leaves rows behind decides what the next test in the same file
 * sees. The schema makes that leak stop at the file boundary; this makes it
 * stop at the test boundary too.
 */
beforeEach(async () => {
    await truncateSignalTables();
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
