import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { historyConfig } from '../../config/history.config.js';

import { FORWARD_HORIZON_NAMES } from './indicator-performance.types.js';

import type {
    ForwardHorizon,
    IndicatorVote,
    SettleUpdate,
    UnsettledVote,
} from './indicator-performance.types.js';

const HOUR_MS = 3_600_000;
const IN_MEMORY_DATABASE_PATH = ':memory:';

/**
 * A vote is stored per hour, matching the signal history it came from. The
 * forward return is what needs a longer horizon, and it is filled in later
 * from the candles rather than guessed now.
 */
const INDICATOR_TABLE = 'indicator_vote';

export interface IndicatorVoteRepositoryOptions {
    databasePath: string;
    maxEntries: number;
}

export interface IndicatorVoteRepository {
    record(votes: IndicatorVote[]): void;
    list(symbol: string, limit: number): IndicatorVote[];
    /** Votes with at least one horizon still waiting to be filled in. */
    listUnsettled(symbol: string, limit: number): UnsettledVote[];
    /** Applies forward returns to stored votes, matched by symbol, hour and indicator. */
    settle(symbol: string, updates: SettleUpdate[]): void;
    count(symbol: string): number;
    close(): void;
}

interface VoteRow {
    timestamp: number;
    symbol: string;
    indicator: string;
    signal: string;
    weight: number;
    price: number;
    fwd_return_1h: number | null;
    fwd_return_4h: number | null;
    fwd_return_24h: number | null;
}

export function createIndicatorVoteRepository(
    options: IndicatorVoteRepositoryOptions,
): IndicatorVoteRepository {
    const isInMemory = options.databasePath === IN_MEMORY_DATABASE_PATH;

    if (!isInMemory) {
        mkdirSync(dirname(options.databasePath), { recursive: true });
    }

    const db = new DatabaseSync(options.databasePath);

    let isClosed = false;

    const close = (): void => {
        if (isClosed) {
            return;
        }

        isClosed = true;
        db.close();
    };

    // Anything below can throw — a file that is not a database fails on the
    // first exec — and the handle opened above would then stay open for the
    // life of the process. Readiness probes run this path on a timer, so a
    // leak here is one per probe rather than one per start.
    try {
        if (!isInMemory) {
            db.exec('PRAGMA journal_mode = WAL');
            db.exec('PRAGMA synchronous = NORMAL');
        }

        db.exec('PRAGMA busy_timeout = 5000');

        db.exec(`
            CREATE TABLE IF NOT EXISTS ${INDICATOR_TABLE} (
                symbol TEXT NOT NULL,
                vote_bucket INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                indicator TEXT NOT NULL,
                signal TEXT NOT NULL CHECK (signal IN ('LONG', 'SHORT', 'NEUTRAL')),
                weight INTEGER NOT NULL CHECK (weight >= 0 AND weight <= 100),
                price REAL NOT NULL,
                fwd_return_1h REAL,
                fwd_return_4h REAL,
                fwd_return_24h REAL,
                PRIMARY KEY (symbol, vote_bucket, indicator)
            )
        `);

        // The settlement scan filters on the unresolved horizons, so those
        // three columns get an index of their own rather than a table scan
        // every poller cycle.
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_indicator_vote_unsettled
            ON ${INDICATOR_TABLE} (symbol, timestamp)
            WHERE fwd_return_1h IS NULL
               OR fwd_return_4h IS NULL
               OR fwd_return_24h IS NULL
        `);
    } catch (error) {
        close();
        throw error;
    }

    const upsertStatement = db.prepare(`
        INSERT INTO ${INDICATOR_TABLE} (
            symbol, vote_bucket, timestamp, indicator, signal, weight, price,
            fwd_return_1h, fwd_return_4h, fwd_return_24h
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, vote_bucket, indicator) DO UPDATE SET
            timestamp = excluded.timestamp,
            signal = excluded.signal,
            weight = excluded.weight,
            price = excluded.price
        WHERE excluded.timestamp > ${INDICATOR_TABLE}.timestamp
    `);

    const trimStatement = db.prepare(`
        DELETE FROM ${INDICATOR_TABLE}
        WHERE vote_bucket NOT IN (
            SELECT DISTINCT vote_bucket
            FROM ${INDICATOR_TABLE}
            ORDER BY vote_bucket DESC
            LIMIT ?
        )
    `);

    const selectStatement = db.prepare(`
        SELECT timestamp, symbol, indicator, signal, weight, price,
               fwd_return_1h, fwd_return_4h, fwd_return_24h
        FROM ${INDICATOR_TABLE}
        WHERE symbol = ?
        ORDER BY vote_bucket DESC, indicator
        LIMIT ?
    `);

    const unsettledStatement = db.prepare(`
        SELECT timestamp, symbol, indicator, signal, price,
               fwd_return_1h, fwd_return_4h, fwd_return_24h
        FROM ${INDICATOR_TABLE}
        WHERE symbol = ?
          AND (fwd_return_1h IS NULL
            OR fwd_return_4h IS NULL
            OR fwd_return_24h IS NULL)
        ORDER BY timestamp DESC, indicator
        LIMIT ?
    `);

    const countStatement = db.prepare(
        `SELECT COUNT(*) AS total FROM ${INDICATOR_TABLE} WHERE symbol = ?`,
    );

    function buildSettleStatements() {
        // One prepared statement per horizon, because a partial update must
        // never overwrite a horizon that has already been settled with a
        // null, and that cannot be expressed with a single generic SET.
        const statements = new Map<ForwardHorizon, ReturnType<DatabaseSync['prepare']>>();

        for (const horizon of FORWARD_HORIZON_NAMES) {
            statements.set(
                horizon,
                db.prepare(`
                    UPDATE ${INDICATOR_TABLE}
                    SET fwd_return_${horizon} = ?
                    WHERE symbol = ?
                      AND vote_bucket = ?
                      AND indicator = ?
                      AND fwd_return_${horizon} IS NULL
                `),
            );
        }

        return statements;
    }

    const settleStatements = buildSettleStatements();

    return {
        record(votes: IndicatorVote[]): void {
            if (votes.length === 0) {
                return;
            }

            for (const vote of votes) {
                upsertStatement.run(
                    vote.symbol,
                    Math.floor(vote.timestamp / HOUR_MS),
                    vote.timestamp,
                    vote.indicator,
                    vote.signal,
                    Math.round(vote.weight * 100),
                    vote.price,
                    vote.fwdReturns['1h'] ?? null,
                    vote.fwdReturns['4h'] ?? null,
                    vote.fwdReturns['24h'] ?? null,
                );
            }

            trimStatement.run(options.maxEntries);
        },

        list(symbol: string, limit: number): IndicatorVote[] {
            const rows = selectStatement.all(
                symbol,
                limit,
            ) as unknown as VoteRow[];

            return rows.map((row) => ({
                timestamp: row.timestamp,
                symbol: row.symbol,
                indicator: row.indicator,
                signal: row.signal as IndicatorVote['signal'],
                weight: row.weight / 100,
                price: row.price,
                fwdReturns: {
                    ...(row.fwd_return_1h === null
                        ? {}
                        : { '1h': row.fwd_return_1h }),
                    ...(row.fwd_return_4h === null
                        ? {}
                        : { '4h': row.fwd_return_4h }),
                    ...(row.fwd_return_24h === null
                        ? {}
                        : { '24h': row.fwd_return_24h }),
                },
            }));
        },

        listUnsettled(symbol: string, limit: number): UnsettledVote[] {
            const rows = unsettledStatement.all(
                symbol,
                limit,
            ) as unknown as VoteRow[];

            // One entry per vote, not per hour. The three indicators of a
            // reading share a price but not a verdict, and collapsing them
            // here would let the first one decide for all three.
            return rows.flatMap((row) => {
                // A column that is missing from the row entirely counts as
                // pending, not as settled: a horizon nobody read back is a
                // horizon nobody filled in, and treating it as done would
                // drop it from every later attempt.
                const pending = FORWARD_HORIZON_NAMES.filter((horizon) => {
                    const value = row[`fwd_return_${horizon}` as keyof VoteRow];

                    return value === null || value === undefined;
                });

                if (pending.length === 0) {
                    return [];
                }

                return [
                    {
                        symbol: row.symbol,
                        timestamp: row.timestamp,
                        indicator: row.indicator,
                        price: row.price,
                        signal: row.signal as UnsettledVote['signal'],
                        pending,
                    },
                ];
            });
        },

        settle(symbol: string, updates: SettleUpdate[]): void {
            for (const update of updates) {
                const bucket = Math.floor(update.timestamp / HOUR_MS);

                for (const [horizon, value] of Object.entries(update.returns) as [
                    ForwardHorizon,
                    number,
                ][]) {
                    if (!Number.isFinite(value)) {
                        continue;
                    }

                    const statement = settleStatements.get(horizon);

                    if (statement === undefined) {
                        continue;
                    }

                    // Guarded on the horizon still being null, so a second
                    // pass can never rewrite a return that already exists.
                    statement.run(value, symbol, bucket, update.indicator);
                }
            }
        },

        count(symbol: string): number {
            const rows = countStatement.all(symbol) as unknown as Array<{
                total: number;
            }>;

            return rows[0]?.total ?? 0;
        },

        close,
    };
}

let repositoryInstance: IndicatorVoteRepository | null = null;

export function getIndicatorVoteRepository(): IndicatorVoteRepository {
    repositoryInstance ??= createIndicatorVoteRepository({
        databasePath: historyConfig.databasePath,
        maxEntries: historyConfig.maxEntries,
    });

    return repositoryInstance;
}

export function closeIndicatorVoteRepository(): void {
    repositoryInstance?.close();
    repositoryInstance = null;
}
