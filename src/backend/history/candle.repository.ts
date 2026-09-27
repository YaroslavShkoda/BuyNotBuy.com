import { query } from '../db/pool.js';

import type { Candle } from '../types/market.js';

/**
 * Stored candles, and the only way in or out.
 *
 * The point of the table is that a result measured weeks later can be traced
 * to the exact bars it was measured from. That only works if two things are
 * true of it, and both are enforced here rather than left to the callers:
 *
 * the identity of a bar includes its venue, and a bar that has closed never
 * re-opens. Together they mean a backfill run today and a backtest run in six
 * months read the same rows, and a mid-outage switch of venues is recorded as
 * two series rather than as one series that quietly changed its mind.
 */

/** Which series a read or a write refers to. */
export interface CandleSeriesKey {
    readonly provider: string;
    readonly symbol: string;
    readonly interval: string;
}

/** A candle as stored: the bar itself plus where it came from. */
export interface StoredCandle extends Candle {
    readonly provider: string;
    readonly symbol: string;
    readonly interval: string;
    /** False while the bar is still moving. Never re-opens once true. */
    readonly isClosed: boolean;
    readonly ingestedAt: number;
}

export interface CandleReadOptions {
    /**
     * Whether to leave out bars that are still forming.
     *
     * True by default, and the default is the point. A forming bar is a partial
     * bar: its close keeps moving, so a backtest that read one would compute
     * indicators from data that did not exist when the decision was made. Only
     * the ingester asks for them, and only because it is the thing that decides
     * when they are finished.
     */
    readonly closedOnly?: boolean;
}

export interface CandleWriteOptions {
    /** Defaults to true: an ordinary bar is assumed to have finished. */
    readonly isClosed?: boolean;
}

export interface CandleRepository {
    /** Newest matching bar, or null when the series is empty. */
    getLatest(
        key: CandleSeriesKey,
        options?: CandleReadOptions,
    ): Promise<StoredCandle | null>;
    /** Bars in `[from, to]`, oldest first. */
    getRange(
        key: CandleSeriesKey,
        from: number,
        to: number,
        options?: CandleReadOptions,
    ): Promise<StoredCandle[]>;
    /** Up to `limit` bars strictly older than `timestamp`, newest first. */
    getBefore(
        key: CandleSeriesKey,
        timestamp: number,
        limit: number,
        options?: CandleReadOptions,
    ): Promise<StoredCandle[]>;
    /** Up to `limit` bars strictly newer than `timestamp`, oldest first. */
    getAfter(
        key: CandleSeriesKey,
        timestamp: number,
        limit: number,
        options?: CandleReadOptions,
    ): Promise<StoredCandle[]>;
    /**
     * Inserts one bar, or updates the one already stored under the same identity.
     *
     * Resolves to whether the row was actually written. A write that loses to
     * the rule below is not a failure, and reporting it as one would make a
     * backfill retry forever against a bar that is already correct.
     */
    upsert(
        key: CandleSeriesKey,
        candle: Candle,
        options?: CandleWriteOptions,
    ): Promise<boolean>;
    /** The same, for a whole page. One statement per chunk, so it is atomic. */
    bulkUpsert(
        key: CandleSeriesKey,
        candles: readonly Candle[],
        options?: CandleWriteOptions,
    ): Promise<number>;
    /** How many bars the series holds. */
    count(
        key: CandleSeriesKey,
        options?: CandleReadOptions,
    ): Promise<number>;
}

interface CandleRow {
    provider: string;
    symbol: string;
    interval: string;
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    ingested_at: number;
    is_closed: boolean;
}

function toStored(row: CandleRow): StoredCandle {
    return {
        provider: row.provider,
        symbol: row.symbol,
        interval: row.interval,
        timestamp: row.timestamp,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        isClosed: row.is_closed,
        ingestedAt: row.ingested_at,
    };
}

const SELECT_COLUMNS = `
    provider, symbol, interval, timestamp,
    open, high, low, close, volume,
    ingested_at, is_closed
`;

/**
 * One series, named by a parameter rather than spliced into SQL.
 *
 * The three parts of a key are the ones a caller supplies, and nothing else is
 * ever interpolated. A symbol is operator-supplied configuration and an
 * interval is a string in a URL, so both are untrusted no matter how they got
 * here.
 */
const TABLE = 'market_candles';

function seriesPredicate(from: number): string {
    return `${TABLE}.provider = $${from}
        AND ${TABLE}.symbol = $${from + 1}
        AND ${TABLE}.interval = $${from + 2}`;
}

function closedPredicate(closedOnly: boolean): string {
    return closedOnly ? `AND ${TABLE}.is_closed` : '';
}

/**
 * `ingested_at` is written on conflict, not preserved.
 *
 * A provider that revises a bar is saying something new about it, and the time
 * that revision arrived is part of the record. Keeping the first arrival would
 * make a table of revisions indistinguishable from a table of first readings.
 */
const UPSERT_SQL = `
    INSERT INTO market_candles (
        provider, symbol, interval, timestamp,
        open, high, low, close, volume, ingested_at, is_closed
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (provider, symbol, interval, timestamp) DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume,
        ingested_at = EXCLUDED.ingested_at,
        is_closed = EXCLUDED.is_closed
    WHERE NOT (market_candles.is_closed AND NOT EXCLUDED.is_closed)
    RETURNING timestamp
`;

/**
 * Rows per statement.
 *
 * Six bound values per bar, so a thousand rows is six thousand parameters —
 * comfortably under the protocol limit, and small enough that one failed
 * backfill page does not have to be retried whole.
 */
const CHUNK_SIZE = 1_000;

export function createCandleRepository(): CandleRepository {
    async function read(
        sql: string,
        values: readonly unknown[],
    ): Promise<CandleRow[]> {
        const result = await query<CandleRow>(sql, values);

        return result.rows;
    }

    return {
        async getLatest(key, options) {
            const closedOnly = options?.closedOnly ?? true;
            const rows = await read(
                `SELECT ${SELECT_COLUMNS}
                 FROM market_candles
                 WHERE ${seriesPredicate(1)}
                   ${closedPredicate(closedOnly)}
                 ORDER BY timestamp DESC
                 LIMIT 1`,
                [key.provider, key.symbol, key.interval],
            );

            const row = rows[0];

            return row === undefined ? null : toStored(row);
        },

        async getRange(key, from, to, options) {
            const closedOnly = options?.closedOnly ?? true;
            const rows = await read(
                `SELECT ${SELECT_COLUMNS}
                 FROM market_candles
                 WHERE ${seriesPredicate(1)}
                   AND timestamp >= $4
                   AND timestamp <= $5
                   ${closedPredicate(closedOnly)}
                 ORDER BY timestamp ASC`,
                [key.provider, key.symbol, key.interval, from, to],
            );

            return rows.map(toStored);
        },

        async getBefore(key, timestamp, limit, options) {
            const closedOnly = options?.closedOnly ?? true;
            const rows = await read(
                `SELECT ${SELECT_COLUMNS}
                 FROM market_candles
                 WHERE ${seriesPredicate(1)}
                   AND timestamp < $4
                   ${closedPredicate(closedOnly)}
                 ORDER BY timestamp DESC
                 LIMIT $5`,
                [key.provider, key.symbol, key.interval, timestamp, limit],
            );

            return rows.map(toStored);
        },

        async getAfter(key, timestamp, limit, options) {
            const closedOnly = options?.closedOnly ?? true;
            const rows = await read(
                `SELECT ${SELECT_COLUMNS}
                 FROM market_candles
                 WHERE ${seriesPredicate(1)}
                   AND timestamp > $4
                   ${closedPredicate(closedOnly)}
                 ORDER BY timestamp ASC
                 LIMIT $5`,
                [key.provider, key.symbol, key.interval, timestamp, limit],
            );

            return rows.map(toStored);
        },

        async upsert(key, candle, options) {
            const isClosed = options?.isClosed ?? true;
            const result = await query<{ timestamp: number }>(UPSERT_SQL, [
                key.provider,
                key.symbol,
                key.interval,
                candle.timestamp,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                candle.volume,
                Date.now(),
                isClosed,
            ]);

            // `null` would mean the driver did not report a count, and guessing
            // "one row" there would report a write that may not have happened.
            return (result.rowCount ?? 0) > 0;
        },

        async bulkUpsert(key, candles, options) {
            if (candles.length === 0) {
                return 0;
            }

            const isClosed = options?.isClosed ?? true;
            const ingestedAt = Date.now();
            let written = 0;

            for (let start = 0; start < candles.length; start += CHUNK_SIZE) {
                const chunk = candles.slice(start, start + CHUNK_SIZE);
                const values: unknown[] = [];
                const rows: string[] = [];

                for (const candle of chunk) {
                    const base = values.length;

                    values.push(
                        key.provider,
                        key.symbol,
                        key.interval,
                        candle.timestamp,
                        candle.open,
                        candle.high,
                        candle.low,
                        candle.close,
                        candle.volume,
                        ingestedAt,
                        isClosed,
                    );

                    rows.push(
                        `(${Array.from(
                            { length: 11 },
                            (_, offset) => `$${base + offset + 1}`,
                        ).join(', ')})`,
                    );
                }

                const result = await query<{ timestamp: number }>(
                    `INSERT INTO market_candles (
                        provider, symbol, interval, timestamp,
                        open, high, low, close, volume, ingested_at, is_closed
                    )
                    VALUES ${rows.join(', ')}
                    ON CONFLICT (provider, symbol, interval, timestamp) DO UPDATE SET
                        open = EXCLUDED.open,
                        high = EXCLUDED.high,
                        low = EXCLUDED.low,
                        close = EXCLUDED.close,
                        volume = EXCLUDED.volume,
                        ingested_at = EXCLUDED.ingested_at,
                        is_closed = EXCLUDED.is_closed
                    WHERE NOT (market_candles.is_closed AND NOT EXCLUDED.is_closed)
                    RETURNING timestamp`,
                    values,
                );

                written += result.rowCount ?? 0;
            }

            return written;
        },

        async count(key, options) {
            const closedOnly = options?.closedOnly ?? true;
            const result = await query<{ count: number }>(
                `SELECT COUNT(*)::int AS count
                 FROM market_candles
                 WHERE ${seriesPredicate(1)}
                   ${closedPredicate(closedOnly)}`,
                [key.provider, key.symbol, key.interval],
            );

            return result.rows[0]?.count ?? 0;
        },
    };
}

/** The process-wide repository, like the pool it borrows connections from. */
export const candleRepository: CandleRepository = createCandleRepository();
