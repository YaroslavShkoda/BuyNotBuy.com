import { historyConfig } from '../../config/history.config.js';
import { query, withTransaction } from '../../db/pool.js';

import { FORWARD_HORIZON_NAMES } from './indicator-performance.types.js';

import type {
    ForwardHorizon,
    IndicatorVote,
    SettleUpdate,
    UnsettledVote,
} from './indicator-performance.types.js';

const HOUR_MS = 3_600_000;

/**
 * A vote is stored per hour, matching the signal history it came from. The
 * forward return is what needs a longer horizon, and it is filled in later
 * from the candles rather than guessed now.
 */
const INDICATOR_TABLE = 'indicator_vote';

export interface IndicatorVoteRepositoryOptions {
    maxEntries: number;
}

export interface IndicatorVoteRepository {
    record(votes: IndicatorVote[]): Promise<void>;
    list(symbol: string, limit: number): Promise<IndicatorVote[]>;
    /** Votes with at least one horizon still waiting to be filled in. */
    listUnsettled(symbol: string, limit: number): Promise<UnsettledVote[]>;
    /** Applies forward returns to stored votes, matched by symbol, hour and indicator. */
    settle(symbol: string, updates: SettleUpdate[]): Promise<void>;
    count(symbol: string): Promise<number>;
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

const UPSERT_SQL = `
    INSERT INTO ${INDICATOR_TABLE} (
        symbol, vote_bucket, timestamp, indicator, signal, weight, price,
        fwd_return_1h, fwd_return_4h, fwd_return_24h
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (symbol, vote_bucket, indicator) DO UPDATE SET
        timestamp = EXCLUDED.timestamp,
        signal = EXCLUDED.signal,
        weight = EXCLUDED.weight,
        price = EXCLUDED.price
    WHERE EXCLUDED.timestamp > ${INDICATOR_TABLE}.timestamp
`;

const TRIM_SQL = `
    DELETE FROM ${INDICATOR_TABLE}
    WHERE vote_bucket NOT IN (
        SELECT DISTINCT vote_bucket
        FROM ${INDICATOR_TABLE}
        ORDER BY vote_bucket DESC
        LIMIT $1
    )
`;

const SELECT_SQL = `
    SELECT timestamp, symbol, indicator, signal, weight, price,
           fwd_return_1h, fwd_return_4h, fwd_return_24h
    FROM ${INDICATOR_TABLE}
    WHERE symbol = $1
    ORDER BY vote_bucket DESC, indicator
    LIMIT $2
`;

const UNSETTLED_SQL = `
    SELECT timestamp, symbol, indicator, signal, price,
           fwd_return_1h, fwd_return_4h, fwd_return_24h
    FROM ${INDICATOR_TABLE}
    WHERE symbol = $1
      AND (fwd_return_1h IS NULL
        OR fwd_return_4h IS NULL
        OR fwd_return_24h IS NULL)
    ORDER BY timestamp DESC, indicator
    LIMIT $2
`;

/**
 * One statement per horizon, because a partial update must never overwrite a
 * horizon that has already been settled with a null, and that cannot be
 * expressed with a single generic SET.
 */
function settleSql(horizon: ForwardHorizon): string {
    return `
        UPDATE ${INDICATOR_TABLE}
        SET fwd_return_${horizon} = $1
        WHERE symbol = $2
          AND vote_bucket = $3
          AND indicator = $4
          AND fwd_return_${horizon} IS NULL
    `;
}

export function createIndicatorVoteRepository(
    options: IndicatorVoteRepositoryOptions,
): IndicatorVoteRepository {
    const settleStatements = new Map<ForwardHorizon, string>(
        FORWARD_HORIZON_NAMES.map((horizon) => [horizon, settleSql(horizon)]),
    );

    return {
        async record(votes: IndicatorVote[]): Promise<void> {
            if (votes.length === 0) {
                return;
            }

            // One transaction for the batch: a half-written reading is a
            // reading whose indicators disagree with each other, and the
            // settlement scan would then price horizons off the wrong price.
            await withTransaction(async (client) => {
                for (const vote of votes) {
                    await client.query(UPSERT_SQL, [
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
                    ]);
                }

                await client.query(TRIM_SQL, [options.maxEntries]);
            });
        },

        async list(symbol: string, limit: number): Promise<IndicatorVote[]> {
            const result = await query<VoteRow>(SELECT_SQL, [symbol, limit]);

            return result.rows.map((row) => ({
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

        async listUnsettled(
            symbol: string,
            limit: number,
        ): Promise<UnsettledVote[]> {
            const result = await query<VoteRow>(UNSETTLED_SQL, [symbol, limit]);

            // One entry per vote, not per hour. The three indicators of a
            // reading share a price but not a verdict, and collapsing them
            // here would let the first one decide for all three.
            return result.rows.flatMap((row) => {
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

        async settle(symbol: string, updates: SettleUpdate[]): Promise<void> {
            if (updates.length === 0) {
                return;
            }

            await withTransaction(async (client) => {
                for (const update of updates) {
                    const bucket = Math.floor(update.timestamp / HOUR_MS);

                    for (const [horizon, value] of Object.entries(
                        update.returns,
                    ) as [ForwardHorizon, number][]) {
                        if (!Number.isFinite(value)) {
                            continue;
                        }

                        const statement = settleStatements.get(horizon);

                        if (statement === undefined) {
                            continue;
                        }

                        // Guarded on the horizon still being null, so a second
                        // pass can never rewrite a return that already exists.
                        await client.query(statement, [
                            value,
                            symbol,
                            bucket,
                            update.indicator,
                        ]);
                    }
                }
            });
        },

        async count(symbol: string): Promise<number> {
            const result = await query<{ total: number }>(
                `SELECT COUNT(*) AS total FROM ${INDICATOR_TABLE} WHERE symbol = $1`,
                [symbol],
            );

            return result.rows[0]?.total ?? 0;
        },
    };
}

let repositoryInstance: IndicatorVoteRepository | null = null;

export function getIndicatorVoteRepository(): IndicatorVoteRepository {
    repositoryInstance ??= createIndicatorVoteRepository({
        maxEntries: historyConfig.maxEntries,
    });

    return repositoryInstance;
}
