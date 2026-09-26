import { Pool, types } from 'pg';

import { databaseConfig } from '../config/database.config.js';

import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * `BIGINT` arrives as a string, and this service stores millisecond timestamps
 * in one.
 *
 * `pg` returns int8 as text because the value can exceed what a JavaScript
 * number holds. These columns cannot: a timestamp in milliseconds is around
 * 1.7e12 and an hour bucket around 4.9e5, both far inside `Number.MAX_SAFE_INTEGER`
 * (~9e15). Parsing them as numbers here keeps the repositories reading the same
 * values SQLite returned, instead of every call site having to know which
 * columns came back as text.
 */
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));

/**
 * The connection string with this service's timeouts folded into its `options`.
 *
 * The timeouts go into the startup options rather than into a `SET` issued per
 * client. One round trip instead of two, and — more usefully — the limits hold
 * on *every* connection in the pool, including ones opened later, which a `SET`
 * on one borrowed client would not.
 *
 * They are written back into the connection string rather than passed as a
 * separate `options` key on purpose. When a connection string carries `options`
 * of its own, `pg` uses that one and ignores the key: a pool configured with
 * `options: '-c statement_timeout=...'` next to a connection string carrying
 * `options=-c search_path=...` silently applies the search path and not the
 * timeout, which looks like a timeout that never took effect.
 *
 * Whatever `options` the connection string already carries is kept, because the
 * connection string is the operator's to set — a `search_path` in it is a
 * legitimate deployment choice, not something this pool gets to discard.
 */
function connectionStringWithTimeouts(): string {
    const parsed = new URL(databaseConfig.connectionString);
    const carried = parsed.searchParams.get('options');

    const parts = [
        `-c statement_timeout=${databaseConfig.statementTimeoutMs}`,
        `-c lock_timeout=${databaseConfig.lockTimeoutMs}`,
    ];

    if (carried !== null && carried !== '') {
        parts.unshift(carried);
    }

    parsed.searchParams.set('options', parts.join(' '));

    return parsed.toString();
}

let pool: Pool | null = null;

/**
 * The process-wide connection pool.
 *
 * Created on first use rather than at import time: importing this module must
 * stay free of side effects, because several unit tests import the modules
 * above it without ever intending to touch a database.
 */
export function getPool(): Pool {
    pool ??= new Pool({
        connectionString: connectionStringWithTimeouts(),
        max: databaseConfig.poolMax,
        idleTimeoutMillis: databaseConfig.idleTimeoutMs,
        connectionTimeoutMillis: databaseConfig.connectionTimeoutMs,
        application_name: databaseConfig.applicationName,
    });

    return pool;
}

export async function query<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
): Promise<QueryResult<Row>> {
    return getPool().query<Row>(text, values as unknown[]);
}

/**
 * Runs `work` inside a transaction, committing on return and rolling back on
 * a throw.
 *
 * Borrowed client, not `pool.query`: the statements in a transaction have to
 * run on one connection, and without holding it a second caller could
 * interleave its own statement into the middle of this one.
 */
export async function withTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
): Promise<T> {
    const client = await getPool().connect();

    try {
        await client.query('BEGIN');

        try {
            const result = await work(client);
            await client.query('COMMIT');

            return result;
        } catch (error) {
            // A rollback that fails means the connection itself is gone, and
            // its error would replace the one that actually describes what
            // went wrong. The work failed either way; the work's own error is
            // the one worth reporting.
            await client.query('ROLLBACK').catch(() => undefined);

            throw error;
        }
    } finally {
        client.release();
    }
}

/**
 * Closes the pool and waits for the connections to drain.
 *
 * Awaited on shutdown: a process that exits while a write is still in flight
 * loses that write, and the history is exactly the record that must not have
 * holes in it.
 */
export async function closePool(): Promise<void> {
    const current = pool;
    pool = null;

    if (current === null) {
        return;
    }

    await current.end();
}

/** Whether a pool exists. Used by shutdown paths that must not create one. */
export function isPoolOpen(): boolean {
    return pool !== null;
}
