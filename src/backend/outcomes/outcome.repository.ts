import { withTransaction, query as defaultQuery } from '../db/pool.js';
import { measureOutcome } from './outcome.js';
import { outcomeConfig } from '../config/outcome.config.js';

import type { SignalOutcome, OutcomeVerdict } from './outcome.js';
import type { Candle } from '../types/market.js';
import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Turns a live signal and the bars that followed it into a measurement.
 *
 * Deliberately the only bridge between the two. Nothing else in the system is
 * allowed to decide whether a signal was right, because the moment a second
 * place decides it there are two numbers for the same trade and a report has
 * no way to say which one it is showing.
 *
 * Pure with respect to the market: given the same signal and the same series it
 * produces the same row, whatever ran in between. A measurement that depended
 * on when it was computed could not be audited, and an outcome that cannot be
 * audited cannot be used to promote a strategy.
 */

export interface OutcomeSeriesKey {
    symbol: string;
    provider: string;
    interval: string;
}

export interface SettleInput {
    readonly key: OutcomeSeriesKey;
    readonly stateId?: number | null;
    readonly direction: 'LONG' | 'SHORT';
    readonly entryTimestamp: number;
    readonly entryPrice: number;
    /** Every bar available after the entry, oldest first. */
    readonly candles: readonly Candle[];
    readonly closedBy?: SignalOutcome['closedBy'];
    readonly regime?: string | null;
    readonly dataQuality?: number | null;
    readonly strategyVersionId?: number | null;
    readonly now: number;
}

export interface OutcomeRow {
    readonly id: string;
    readonly symbol: string;
    readonly provider: string;
    readonly interval: string;
    readonly stateId: number | null;
    readonly direction: 'LONG' | 'SHORT';
    readonly verdict: OutcomeVerdict;
    readonly horizonBars: number;
    readonly entryTimestamp: number;
    readonly entryPrice: number;
    readonly exitTimestamp: number | null;
    readonly exitPrice: number | null;
    readonly returnFraction: number | null;
    readonly maxFavourable: number | null;
    readonly maxAdverse: number | null;
    readonly closedBy: SignalOutcome['closedBy'];
    readonly regime: string | null;
    readonly dataQuality: number | null;
    readonly strategyVersionId: number | null;
    readonly createdAt: number;
    readonly updatedAt: number;
}

export interface OutcomeRepository {
    /**
     * Measures a signal and stores one row per horizon, updating in place.
     *
     * A signal that was unresolved last run and is resolved now is the same
     * measurement finished, not a second one. The unique key is what makes that
     * true, and it is why a report over this table can be trusted not to count
     * the same trade twice.
     */
    settle(input: SettleInput): Promise<OutcomeRow[]>;
    /** Everything still waiting for bars, oldest first. */
    unresolved(limit?: number): Promise<OutcomeRow[]>;
    /** Every measurement for one series at one horizon. */
    forSeries(
        key: OutcomeSeriesKey,
        horizonBars: number,
        limit?: number,
    ): Promise<OutcomeRow[]>;
    /**
     * Removes measurements whose signal is older than the cutoff.
     *
     * Scoped through `signal_state` rather than by age alone: a measurement
     * whose live signal is still current is not a measurement that has been
     * superseded, however old its entry bar.
     */
    deleteBefore(cutoff: number): Promise<number>;
}

export type OutcomeQuery = (
    text: string,
    values?: readonly unknown[],
) => Promise<QueryResult<QueryResultRow>>;

const COLUMNS = `
    id, symbol, provider, interval, signal_state_id, direction, verdict,
    horizon_bars, entry_timestamp, entry_price, exit_timestamp, exit_price,
    return_fraction, max_favourable, max_adverse, closed_by,
    regime, data_quality, strategy_version_id, created_at, updated_at
`;

function toRow(row: QueryResultRow): OutcomeRow {
    return {
        id: String(row.id),
        symbol: row.symbol,
        provider: row.provider,
        interval: row.interval,
        stateId: row.signal_state_id === null ? null : Number(row.signal_state_id),
        direction: row.direction,
        verdict: row.verdict,
        horizonBars: Number(row.horizon_bars),
        entryTimestamp: Number(row.entry_timestamp),
        entryPrice: Number(row.entry_price),
        exitTimestamp:
            row.exit_timestamp === null ? null : Number(row.exit_timestamp),
        exitPrice: row.exit_price === null ? null : Number(row.exit_price),
        returnFraction:
            row.return_fraction === null ? null : Number(row.return_fraction),
        maxFavourable:
            row.max_favourable === null ? null : Number(row.max_favourable),
        maxAdverse:
            row.max_adverse === null ? null : Number(row.max_adverse),
        closedBy: row.closed_by,
        regime: row.regime,
        dataQuality:
            row.data_quality === null ? null : Number(row.data_quality),
        strategyVersionId:
            row.strategy_version_id === null
                ? null
                : Number(row.strategy_version_id),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}

export function createOutcomeRepository(
    query: OutcomeQuery = (text, values) =>
        defaultQuery(text, values as unknown[]),
    transaction: <T>(
        work: (client: { query: OutcomeQuery }) => Promise<T>,
    ) => Promise<T> = withTransaction,
): OutcomeRepository {
    return {
        async settle(input) {
            const outcome = measureOutcome({
                symbol: input.key.symbol,
                entryTimestamp: input.entryTimestamp,
                entryPrice: input.entryPrice,
                direction: input.direction,
                candles: input.candles,
                config: outcomeConfig,
                ...(input.closedBy === undefined
                    ? {}
                    : { closedBy: input.closedBy }),
            });

            // One transaction for the whole set of horizons. A signal measured
            // at one bar and not at twelve is not a partial answer, it is a
            // table that will report a different hit rate depending on which
            // rows happened to make it in.
            return transaction(async (client) => {
                const inside = client.query.bind(client) as OutcomeQuery;
                const written: OutcomeRow[] = [];

                for (const horizon of outcome.horizons) {
                    const forward = input.candles.filter(
                        (candle) => candle.timestamp > input.entryTimestamp,
                    );
                    const end = forward[horizon.bars - 1];

                    const result = await inside(
                        `INSERT INTO signal_outcome (
                            symbol, provider, interval, signal_state_id,
                            direction, verdict, horizon_bars,
                            entry_timestamp, entry_price, exit_timestamp, exit_price,
                            return_fraction, max_favourable, max_adverse, closed_by,
                            regime, data_quality, strategy_version_id,
                            created_at, updated_at
                         ) VALUES (
                            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                            $12, $13, $14, $15, $16, $17, $18, $19, $19
                         )
                         ON CONFLICT (
                            symbol, provider, interval, signal_state_id, horizon_bars
                         ) DO UPDATE SET
                            verdict = EXCLUDED.verdict,
                            entry_price = EXCLUDED.entry_price,
                            exit_timestamp = EXCLUDED.exit_timestamp,
                            exit_price = EXCLUDED.exit_price,
                            return_fraction = EXCLUDED.return_fraction,
                            max_favourable = EXCLUDED.max_favourable,
                            max_adverse = EXCLUDED.max_adverse,
                            closed_by = EXCLUDED.closed_by,
                            updated_at = EXCLUDED.updated_at
                         RETURNING *`,
                        [
                            input.key.symbol,
                            input.key.provider,
                            input.key.interval,
                            input.stateId ?? null,
                            input.direction,
                            horizon.verdict,
                            horizon.bars,
                            input.entryTimestamp,
                            input.entryPrice,
                            end?.timestamp ?? null,
                            end?.close ?? null,
                            horizon.returnFraction,
                            horizon.maxFavourable,
                            horizon.maxAdverse,
                            outcome.closedBy,
                            input.regime ?? null,
                            input.dataQuality ?? null,
                            input.strategyVersionId ?? null,
                            input.now,
                        ],
                    );

                    const row = result.rows[0];

                    if (row !== undefined) {
                        written.push(toRow(row));
                    }
                }

                return written;
            });
        },

        async unresolved(limit = 500) {
            // Grouped by signal rather than returned row by row, because what
            // the settlement scan needs is "the bars are ready for this
            // signal", and a list of nine rows for the same three signals makes
            // the caller rediscover that.
            const result = await query(
                `SELECT DISTINCT ON (symbol, provider, interval, signal_state_id)
                    symbol, provider, interval, signal_state_id,
                    MIN(entry_timestamp) AS entry_timestamp
                 FROM signal_outcome
                 WHERE verdict IN ('unknown', 'expired')
                 GROUP BY symbol, provider, interval, signal_state_id
                 ORDER BY symbol, provider, interval, signal_state_id,
                          entry_timestamp ASC
                 LIMIT $1`,
                [limit],
            );

            return result.rows.map(toRow);
        },

        async forSeries(key, horizonBars, limit = 10_000) {
            const result = await query(
                `SELECT ${COLUMNS}
                 FROM signal_outcome
                 WHERE symbol = $1 AND provider = $2 AND interval = $3
                   AND horizon_bars = $4
                 ORDER BY entry_timestamp DESC
                 LIMIT $5`,
                [key.symbol, key.provider, key.interval, horizonBars, limit],
            );

            return result.rows.map(toRow);
        },

        async deleteBefore(cutoff) {
            const result = await query(
                `DELETE FROM signal_outcome
                 WHERE entry_timestamp < $1
                   AND (signal_state_id IS NULL OR signal_state_id NOT IN (
                       SELECT id FROM signal_state WHERE updated_at >= $1
                   ))`,
                [cutoff],
            );

            return result.rowCount ?? 0;
        },
    };
}

export const outcomeRepository: OutcomeRepository = createOutcomeRepository();
