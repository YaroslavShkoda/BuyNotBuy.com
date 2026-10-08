import { hashValue } from '../config/strategy-fingerprint.js';
import { query } from '../db/pool.js';

import type { Candle } from '../types/market.js';
import type { StrategyVersion } from './strategy-version.repository.js';

interface StoredSnapshot {
    id: number;
    createdAt: number;
    symbol: string;
    strategyVersionId: number;
    inputHash: string;
    snapshot: unknown;
    firstCandleTs: number;
    lastCandleTs: number;
    candleCount: number;
    candlesHash: string;
    /**
     * Which venue the bars came from, and on what timeframe.
     *
     * **Null for a row written before migration 18**, and null is not a default
     * and not "unknown": it means nobody recorded it, and a reader has to be
     * able to tell that apart from a venue that happens to be called
     * "unknown". The column stayed nullable for exactly that reason, and a
     * fabricated default would have been the tidier choice.
     */
    readonly provider: string | null;
    readonly interval: string | null;
}

interface SignalSnapshotRepository {
    /**
     * Stores a snapshot, or returns the one already stored for the same inputs.
     *
     * Idempotent on the input hash rather than on the timestamp: the analysis
     * runs on every page load, and an unchanged market should not fill the
     * table with identical rows. It is also what makes a retry safe — the
     * buffer that retries a failed write will not produce a second snapshot
     * when the first one actually landed.
     */
    record(input: {
        symbol: string;
        strategyVersion: StrategyVersion;
        snapshot: unknown;
        candles: Candle[];
        /** Included in the identity, so the same candles under a new strategy differ. */
        price: number;
        /**
         * The venue the bars came from, and the timeframe they are on.
         *
         * **Part of the identity, not decoration.** The fingerprint used to be
         * `{symbol, price, strategyVersionId, candlesHash}`, so two venues
         * serving identical candles hashed the same, the unique index on
         * `(symbol, input_hash)` matched, and `ON CONFLICT DO NOTHING` threw
         * the second away — leaving a row attributed to whichever venue arrived
         * first and carrying nothing that said which one that was. `second-source.ts`
         * measured why that is not cosmetic: the provider moved the numbers by
         * +5.74% against +0.45% on one identical rule.
         */
        provider: string;
        interval: string;
    }): Promise<{ id: number; created: boolean }>;

    byId(id: number): Promise<StoredSnapshot | null>;
    list(symbol: string, limit: number): Promise<StoredSnapshot[]>;
}

interface SnapshotRow {
    id: number;
    created_at: number;
    symbol: string;
    strategy_version_id: number;
    input_hash: string;
    snapshot: unknown;
    first_candle_ts: number;
    last_candle_ts: number;
    candle_count: number;
    candles_hash: string;
    /**
     * Null for a row written before migration 18.
     *
     * Null is not "unknown" and is not a default: it means nobody recorded it,
     * and a reader must be able to tell that apart from a venue that happens to
     * be called "unknown". The column stayed nullable for exactly that reason.
     */
    provider: string | null;
    interval: string | null;
}

const SELECT_COLUMNS = `
    id, created_at, symbol, strategy_version_id, input_hash, snapshot,
    first_candle_ts, last_candle_ts, candle_count, candles_hash,
    provider, interval
`;

function toStored(row: SnapshotRow): StoredSnapshot {
    return {
        id: row.id,
        createdAt: row.created_at,
        symbol: row.symbol,
        strategyVersionId: row.strategy_version_id,
        inputHash: row.input_hash,
        snapshot: row.snapshot,
        firstCandleTs: row.first_candle_ts,
        lastCandleTs: row.last_candle_ts,
        candleCount: row.candle_count,
        candlesHash: row.candles_hash,
        provider: row.provider,
        interval: row.interval,
    };
}

/**
 * Identifies the exact inputs a snapshot was computed from.
 *
 * The price and the candle *contents* both take part, not only the timestamps:
 * a provider that silently revised a close would otherwise produce a snapshot
 * that claims to have been derived from prices the database never saw, and the
 * recorded outcome would then be compared against a different market than the
 * one that produced it.
 *
 * The venue and the timeframe take part for the same reason, one step further:
 * without them, two venues serving identical candles are the same record, and
 * the second is not stored at all.
 */
export function inputFingerprint(
    symbol: string,
    price: number,
    candles: Candle[],
    strategyVersionId: number,
    provider: string,
    interval: string,
): { inputHash: string; candlesHash: string; firstCandleTs: number; lastCandleTs: number } {
    const candlesHash = hashValue(
        candles.map((candle) => [
            candle.timestamp,
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            candle.volume,
        ]),
    );

    const first = candles[0];
    const last = candles[candles.length - 1];

    return {
        candlesHash,
        firstCandleTs: first?.timestamp ?? 0,
        lastCandleTs: last?.timestamp ?? 0,
        inputHash: hashValue({
            symbol,
            price,
            strategyVersionId,
            candlesHash,
            provider,
            interval,
        }),
    };
}

export function createSignalSnapshotRepository(): SignalSnapshotRepository {
    return {
        async record(input): Promise<{ id: number; created: boolean }> {
            const { inputHash, candlesHash, firstCandleTs, lastCandleTs } =
                inputFingerprint(
                    input.symbol,
                    input.price,
                    input.candles,
                    input.strategyVersion.id,
                    input.provider,
                    input.interval,
                );

            const result = await query<{ id: number }>(
                `INSERT INTO signal_snapshot (
                     created_at, symbol, strategy_version_id, input_hash, snapshot,
                     first_candle_ts, last_candle_ts, candle_count, candles_hash,
                     provider, interval
                 )
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
                 ON CONFLICT (instrument_id, input_hash) DO NOTHING
                 RETURNING id`,
                [
                    Date.now(),
                    input.symbol,
                    input.strategyVersion.id,
                    inputHash,
                    JSON.stringify(input.snapshot),
                    firstCandleTs,
                    lastCandleTs,
                    input.candles.length,
                    candlesHash,
                    input.provider,
                    input.interval,
                ],
            );

            const created = result.rows[0];

            if (created !== undefined) {
                return { id: created.id, created: true };
            }

            const existing = await query<{ id: number }>(
                `SELECT id FROM signal_snapshot
                 WHERE instrument_id = (SELECT id FROM instrument WHERE ticker = $1)
                   AND input_hash = $2`,
                [input.symbol, inputHash],
            );

            const found = existing.rows[0];

            if (found === undefined) {
                throw new Error(
                    'A signal snapshot conflicted on its input hash but could ' +
                        'not be read back. The row is in an unknown state.',
                );
            }

            return { id: found.id, created: false };
        },

        async byId(id: number): Promise<StoredSnapshot | null> {
            const result = await query<SnapshotRow>(
                `SELECT ${SELECT_COLUMNS} FROM signal_snapshot WHERE id = $1`,
                [id],
            );

            const row = result.rows[0];

            return row === undefined ? null : toStored(row);
        },

        async list(symbol: string, limit: number): Promise<StoredSnapshot[]> {
            const result = await query<SnapshotRow>(
                `SELECT ${SELECT_COLUMNS}
                 FROM signal_snapshot
                 WHERE instrument_id = (SELECT id FROM instrument WHERE ticker = $1)
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2`,
                [symbol, limit],
            );

            return result.rows.map((row) => toStored(row));
        },
    };
}

let shared: SignalSnapshotRepository | null = null;

export function getSignalSnapshotRepository(): SignalSnapshotRepository {
    shared ??= createSignalSnapshotRepository();

    return shared;
}

/** Test seam: the singleton exists so production shares one, not so tests share rows. */
export function resetSignalSnapshotRepository(): void {
    shared = null;
}
