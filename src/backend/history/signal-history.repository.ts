import { historyConfig } from '../config/history.config.js';
import { marketConfig } from '../config/market.config.js';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../db/migrations.js';
import { query } from '../db/pool.js';

import type { SignalHistoryEntry, SignalHistorySeries } from './signal-history.types.js';

// Signal snapshots are hourly by design, so a one-record-per-hour bucket keeps
// the history meaningful in hours instead of duplicating the same state for
// every page load.
const HOUR_MS = 3_600_000;

export interface SignalHistoryRepositoryOptions {
    maxEntries: number;
}

export interface SignalHistoryRepository {
    record(entry: SignalHistoryEntry): Promise<void>;
    list(
        symbol: string,
        limit: number,
        before?: number,
        series?: Partial<SignalHistorySeries>,
    ): Promise<SignalHistoryEntry[]>;
    /**
     * Drops entries past the retention limit for one series. Returns how many.
     *
     * Scoped to a series, not to a symbol: a symbol analysed at two intervals
     * has one limit shared by two histories, and whichever wrote last would
     * quietly cut the other's retention.
     */
    trimRetention(symbol: string, series?: Partial<SignalHistorySeries>): Promise<number>;
    /** Schema version currently stored in the database. */
    schemaVersion(): Promise<number>;
    /**
     * Server-side timeouts in force on this pool's connections.
     *
     * `statement_timeout` and `lock_timeout` are GUCs the server holds per
     * connection, so they can only be read back from a connection they were
     * set on. That is exactly why a health endpoint has to ask the pool rather
     * than open a connection of its own and assume.
     */
    durabilitySettings(): Promise<{ statementTimeout: string; lockTimeout: string }>;
}

interface SignalHistoryRow {
    timestamp: number;
    symbol: string;
    provider: string;
    interval: string;
    signal: string;
    consensus: number;
    price: number;
    regime: string | null;
    data_quality: number | null;
    data_quality_usable: boolean | null;
    data_quality_worst: string | null;
}

/** Newest analysis of the hour wins; a late-arriving older snapshot
 *  must not overwrite a fresher one. */
const UPSERT_SQL = `
    INSERT INTO signal_history (
        symbol, provider, interval, hour_bucket, timestamp, signal, consensus, price,
        regime, data_quality, data_quality_usable, data_quality_worst
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (instrument_id, provider, interval, hour_bucket) DO UPDATE SET
        timestamp = EXCLUDED.timestamp,
        signal = EXCLUDED.signal,
        consensus = EXCLUDED.consensus,
        price = EXCLUDED.price,
        regime = EXCLUDED.regime,
        data_quality = EXCLUDED.data_quality,
        data_quality_usable = EXCLUDED.data_quality_usable,
        data_quality_worst = EXCLUDED.data_quality_worst
    WHERE EXCLUDED.timestamp > signal_history.timestamp
`;

/**
 * Drops everything older than the newest `maxEntries` buckets of *one* symbol.
 *
 * Two defects in the version this replaces. It was not scoped to a symbol, so a
 * symbol with a short history and a symbol with a long one competed for one
 * limit: three symbols at `maxEntries = 720` kept 240 hours each, and the
 * slowest symbol silently cut the retention of the others. And it was written
 * as `WHERE hour_bucket NOT IN (SELECT DISTINCT ... ORDER BY ... LIMIT)`, which
 * PostgreSQL cannot turn into an index walk — the `DISTINCT` plus the `NOT IN`
 * force a sequential scan and a hashed anti-join, on every single write.
 *
 * A keyed subquery with `OFFSET` reads down the primary key, and the delete
 * that follows is a range delete on the same key.
 *
 * `$2` is the count of buckets to keep, not the offset: the subquery lands on
 * the *oldest bucket being kept* — position `keep - 1` counting from zero — and
 * the delete is strictly below it. Passing the keep count as an offset instead
 * would keep one bucket too many, and the error would be a table that is
 * quietly `maxEntries + 1` rows deep forever.
 *
 * When a symbol has fewer rows than the limit the subquery returns nothing,
 * the cutoff falls back to the row's own bucket, and the condition is false —
 * so a short history is left alone rather than emptied.
 */
const TRIM_SQL = `
    DELETE FROM signal_history
    WHERE instrument_id = (SELECT id FROM instrument WHERE ticker = $1)
      AND provider = $2
      AND interval = $3
      AND hour_bucket < COALESCE(
          (
              SELECT hour_bucket
              FROM signal_history
              WHERE instrument_id = (SELECT id FROM instrument WHERE ticker = $1)
                AND provider = $2 AND interval = $3
              ORDER BY hour_bucket DESC
              LIMIT 1 OFFSET $4 - 1
          ),
          hour_bucket
      )
    RETURNING 1
`;

const COLUMNS = `
    timestamp, symbol, provider, interval, signal, consensus, price,
    regime, data_quality, data_quality_usable, data_quality_worst
`;

const SELECT_SQL = `
    SELECT ${COLUMNS}
    FROM signal_history
    WHERE instrument_id = (SELECT id FROM instrument WHERE ticker = $1)
      AND provider = $2 AND interval = $3
    ORDER BY hour_bucket DESC
    LIMIT $4
`;

/**
 * `before` is an hour bucket, so a page boundary is expressed in the same
 * unit the rows are keyed by. Filtering here rather than in memory matters:
 * "give me 20 older entries" has to stay one indexed read, not a full table
 * scan that throws most of it away.
 */
const SELECT_BEFORE_SQL = `
    SELECT ${COLUMNS}
    FROM signal_history
    WHERE instrument_id = (SELECT id FROM instrument WHERE ticker = $1)
      AND provider = $2 AND interval = $3
      AND hour_bucket < $4
    ORDER BY hour_bucket DESC
    LIMIT $5
`;

export function createSignalHistoryRepository(
    options: SignalHistoryRepositoryOptions,
): SignalHistoryRepository {
    /**
     * Fills in the series a caller did not name.
     *
     * Defaulting rather than requiring keeps every existing call site correct:
     * a symbol analysed at one interval is a series, and a caller that has
     * never heard of a second one should not have to say so on every write.
     */
    const seriesOf = (
        symbol: string,
        series: Partial<SignalHistorySeries> | undefined,
    ): SignalHistorySeries => ({
        symbol,
        provider: series?.provider ?? marketConfig.provider,
        interval: series?.interval ?? marketConfig.candleInterval,
    });

    return {
        async record(entry: SignalHistoryEntry): Promise<void> {
            // Not a transaction any more. It held a paired trim, and the trim
            // was the reason: retention now runs on its own cadence, and a
            // single upsert does not need an explicit transaction to be atomic.
            const series = seriesOf(entry.symbol, entry);
            const context = entry.context;

            await query(UPSERT_SQL, [
                series.symbol,
                series.provider,
                series.interval,
                Math.floor(entry.timestamp / HOUR_MS),
                entry.timestamp,
                entry.signal,
                Math.round(entry.consensus),
                entry.price,
                context?.regime ?? null,
                context?.dataQuality ?? null,
                context?.dataQualityUsable ?? null,
                context?.dataQualityWorst ?? null,
            ]);
        },

        async trimRetention(
            symbol: string,
            series?: Partial<SignalHistorySeries>,
        ): Promise<number> {
            const resolved = seriesOf(symbol, series);

            // `RETURNING` is what lets a data-modifying statement sit in a CTE
            // and still be counted; without it PostgreSQL rejects the query
            // rather than silently running the delete and discarding it.
            const result = await query<{ count: number }>(
                `WITH deleted AS (${TRIM_SQL})
                 SELECT COUNT(*)::int AS count FROM deleted`,
                [
                    resolved.symbol,
                    resolved.provider,
                    resolved.interval,
                    options.maxEntries,
                ],
            );

            return result.rows[0]?.count ?? 0;
        },

        async list(
            symbol: string,
            limit: number,
            before?: number,
            series?: Partial<SignalHistorySeries>,
        ): Promise<SignalHistoryEntry[]> {
            const resolved = seriesOf(symbol, series);
            const result = await query<SignalHistoryRow>(
                before === undefined ? SELECT_SQL : SELECT_BEFORE_SQL,
                before === undefined
                    ? [resolved.symbol, resolved.provider, resolved.interval, limit]
                    : [resolved.symbol, resolved.provider, resolved.interval, before, limit],
            );

            // The signal column is guarded by a CHECK constraint at the
            // storage layer, so the narrow cast cannot receive foreign values.
            return result.rows.map((row) => ({
                timestamp: row.timestamp,
                symbol: row.symbol,
                provider: row.provider,
                interval: row.interval,
                signal: row.signal as SignalHistoryEntry['signal'],
                consensus: row.consensus,
                price: row.price,
                context: {
                    regime: row.regime,
                    dataQuality: row.data_quality,
                    dataQualityUsable: row.data_quality_usable,
                    dataQualityWorst: row.data_quality_worst,
                },
            }));
        },

        async schemaVersion(): Promise<number> {
            return currentSchemaVersion();
        },

        async durabilitySettings(): Promise<{
            statementTimeout: string;
            lockTimeout: string;
        }> {
            // One round trip for both: this runs on the readiness probe, and
            // the values are settings of the same connection, so asking twice
            // would only add a second way for the two answers to disagree.
            const result = await query<{
                statement_timeout: string;
                lock_timeout: string;
            }>(
                `SELECT current_setting('statement_timeout') AS statement_timeout,
                        current_setting('lock_timeout') AS lock_timeout`,
            );

            return {
                statementTimeout: result.rows[0]?.statement_timeout ?? '',
                lockTimeout: result.rows[0]?.lock_timeout ?? '',
            };
        },
    };
}

let repositoryInstance: SignalHistoryRepository | null = null;

/**
 * Lazy singleton: no connection is opened at import time, so importing this
 * module stays free of database side effects for the unit tests that never
 * mean to reach one.
 */
export function getSignalHistoryRepository(): SignalHistoryRepository {
    repositoryInstance ??= createSignalHistoryRepository({
        maxEntries: historyConfig.maxEntries,
    });

    return repositoryInstance;
}

/**
 * Verifies the deployment migration job ran before this application build.
 *
 * The repository is a lazy singleton for testability, so the service checks
 * the schema before opening its socket. It never changes the schema itself;
 * deployments run `npm run db:migrate` as a separate job.
 */
export async function assertSignalHistorySchemaReady(): Promise<void> {
    const version = await currentSchemaVersion();

    if (version !== LATEST_SCHEMA_VERSION) {
        throw new Error(
            `Database schema is at version ${version}; this application requires ` +
                `version ${LATEST_SCHEMA_VERSION}. Run the db:migrate job before deploying the application.`,
        );
    }
}
