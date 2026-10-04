import type { QueryResult, QueryResultRow } from 'pg';
import type { SignalDirection, SignalStatus } from '../config/lifecycle.config.js';
import { query as defaultQuery, withTransaction } from '../db/pool.js';

/**
 * The live signal for a series, and the trail of how it got there.
 *
 * Two tables, and the split is the point. `signal_state` holds one row per
 * series and is overwritten in place: it answers "what is happening now", and
 * a query that reads it is a query about the present tense. `signal_transition`
 * is append-only and answers "how did we get here", which is the question the
 * outcome engine and every performance number are built on.
 *
 * The two are separate rather than one table with a status column because they
 * are not the same shape of data. The live row is read on every poll and
 * overwritten; the trail is read in ranges and never changes. Putting them in
 * one table means either the poll rewrites history or the trail is polluted with
 * a row per poll.
 */

export interface SignalStateRow {
    readonly id: string;
    readonly symbol: string;
    readonly provider: string;
    readonly interval: string;
    readonly direction: SignalDirection;
    readonly status: SignalStatus;
    readonly snapshotId: string | null;
    readonly price: number;
    readonly confidence: number;
    readonly publishedAt: number;
    readonly candleTimestamp: number;
    readonly createdAt: number;
    readonly updatedAt: number;
}

export interface SignalTransitionRow {
    readonly id: string;
    readonly stateId: string;
    readonly symbol: string;
    readonly provider: string;
    readonly interval: string;
    readonly fromStatus: SignalStatus | null;
    readonly toStatus: SignalStatus;
    readonly fromDirection: SignalDirection | null;
    readonly toDirection: SignalDirection;
    readonly reason: string;
    readonly candleTimestamp: number;
    readonly price: number;
    readonly createdAt: number;
}

export interface SeriesKey {
    readonly symbol: string;
    readonly provider: string;
    readonly interval: string;
}

export interface WriteSignal {
    readonly direction: SignalDirection;
    readonly status: SignalStatus;
    readonly snapshotId?: string | null;
    readonly price: number;
    readonly confidence: number;
    readonly publishedAt: number;
    readonly candleTimestamp: number;
}

export interface SignalLifecycleRepository {
    getLive(key: SeriesKey): Promise<SignalStateRow | null>;
    /**
     * Writes the live row and its transition in one transaction.
     *
     * One transaction because the two are a single fact. A crash between them
     * would leave a trail saying the signal moved when the live row says it
     * did not, or the reverse, and the outcome engine would measure one and the
     * dashboard would show the other.
     */
    write(
        key: SeriesKey,
        previous: SignalStateRow | null,
        write: WriteSignal,
        transition: {
            reason: string;
            createdAt: number;
        },
    ): Promise<SignalStateRow>;
    transitions(stateId: string, limit?: number): Promise<SignalTransitionRow[]>;
    /** Every closed signal for a series, newest first. The outcome engine. */
    closed(key: SeriesKey, limit?: number): Promise<SignalStateRow[]>;
    deleteBefore(cutoff: number): Promise<number>;
}

const STATE_TABLE = 'signal_state';
const TRANSITION_TABLE = 'signal_transition';

function toState(row: QueryResultRow): SignalStateRow {
    return {
        id: String(row.id),
        symbol: row.symbol,
        provider: row.provider,
        interval: row.interval,
        direction: row.direction,
        status: row.status,
        snapshotId: row.snapshot_id === null ? null : String(row.snapshot_id),
        price: Number(row.price),
        confidence: Number(row.confidence),
        publishedAt: Number(row.published_at),
        candleTimestamp: Number(row.candle_timestamp),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}

function toTransition(row: QueryResultRow): SignalTransitionRow {
    return {
        id: String(row.id),
        stateId: String(row.state_id),
        symbol: row.symbol,
        provider: row.provider,
        interval: row.interval,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        fromDirection: row.from_direction,
        toDirection: row.to_direction,
        reason: row.reason,
        candleTimestamp: Number(row.candle_timestamp),
        price: Number(row.price),
        createdAt: Number(row.created_at),
    };
}

export type SignalQuery = (
    text: string,
    values?: readonly unknown[],
) => Promise<QueryResult<QueryResultRow>>;

export function createSignalLifecycleRepository(
    query: SignalQuery = (text, values) =>
        defaultQuery(text, values as unknown[]),
    transaction: <T>(
        work: (client: { query: SignalQuery }) => Promise<T>,
    ) => Promise<T> = withTransaction,
): SignalLifecycleRepository {
    return {
        async getLive(key) {
            const result = await query(
                `SELECT * FROM ${STATE_TABLE}
                 WHERE symbol = $1 AND provider = $2 AND interval = $3`,
                [key.symbol, key.provider, key.interval],
            );

            const row = result.rows[0];

            return row === undefined ? null : toState(row);
        },

        async write(key, previous, write, transition) {
            // One transaction because the two writes are a single fact. A crash
            // between them would leave a trail saying the signal moved when the
            // live row says it did not, or the reverse, and the outcome engine
            // would measure one and the dashboard would show the other.
            return transaction(async (client) => {
                const inside = client.query.bind(client) as SignalQuery;

                const stateResult = await inside(
                    `INSERT INTO ${STATE_TABLE} (
                        symbol, provider, interval, direction, status,
                        snapshot_id, price, confidence,
                        published_at, candle_timestamp, created_at, updated_at
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
                     ON CONFLICT (symbol, provider, interval) DO UPDATE SET
                        direction = EXCLUDED.direction,
                        status = EXCLUDED.status,
                        snapshot_id = EXCLUDED.snapshot_id,
                        price = EXCLUDED.price,
                        confidence = EXCLUDED.confidence,
                        published_at = EXCLUDED.published_at,
                        candle_timestamp = EXCLUDED.candle_timestamp,
                        updated_at = EXCLUDED.updated_at
                     RETURNING *`,
                    [
                        key.symbol,
                        key.provider,
                        key.interval,
                        write.direction,
                        write.status,
                        write.snapshotId ?? null,
                        write.price,
                        write.confidence,
                        write.publishedAt,
                        write.candleTimestamp,
                        transition.createdAt,
                    ],
                );

                const stateRow = stateResult.rows[0];

                if (stateRow === undefined) {
                    throw new Error('Signal state write returned no row');
                }

                await inside(
                    `INSERT INTO ${TRANSITION_TABLE} (
                        state_id, symbol, provider, interval,
                        from_status, to_status, from_direction, to_direction,
                        reason, candle_timestamp, price, created_at
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                    [
                        stateRow.id,
                        key.symbol,
                        key.provider,
                        key.interval,
                        previous?.status ?? null,
                        write.status,
                        previous?.direction ?? null,
                        write.direction,
                        transition.reason,
                        write.candleTimestamp,
                        write.price,
                        transition.createdAt,
                    ],
                );

                return toState(stateRow);
            });
        },

        async transitions(stateId, limit = 100) {
            const result = await query(
                `SELECT * FROM ${TRANSITION_TABLE}
                 WHERE state_id = $1
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2`,
                [stateId, limit],
            );

            return result.rows.map(toTransition);
        },

        async closed(key, limit = 100) {
            const result = await query(
                `SELECT * FROM ${STATE_TABLE}
                 WHERE symbol = $1 AND provider = $2 AND interval = $3
                   AND status IN ('INVALIDATED', 'EXPIRED', 'CLOSED')
                 ORDER BY candle_timestamp DESC
                 LIMIT $4`,
                [key.symbol, key.provider, key.interval, limit],
            );

            return result.rows.map(toState);
        },

        async deleteBefore(cutoff) {
            const result = await query(
                `DELETE FROM ${TRANSITION_TABLE}
                 WHERE created_at < $1
                   AND state_id NOT IN (
                       SELECT id FROM ${STATE_TABLE} WHERE updated_at >= $1
                   )`,
                [cutoff],
            );

            return result.rowCount ?? 0;
        },
    };
}

export const signalLifecycleRepository: SignalLifecycleRepository =
    createSignalLifecycleRepository();
