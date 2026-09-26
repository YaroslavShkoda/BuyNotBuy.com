import { hashValue } from '../config/strategy-fingerprint.js';
import { query } from '../db/pool.js';

import type { Candle } from '../types/market.js';
import type { StrategyVersion } from './strategy-version.repository.js';

export interface StoredSnapshot {
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
}

export interface SignalSnapshotRepository {
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
}

const SELECT_COLUMNS = `
    id, created_at, symbol, strategy_version_id, input_hash, snapshot,
    first_candle_ts, last_candle_ts, candle_count, candles_hash
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
 */
export function inputFingerprint(
    symbol: string,
    price: number,
    candles: Candle[],
    strategyVersionId: number,
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
                );

            const result = await query<{ id: number }>(
                `INSERT INTO signal_snapshot (
                     created_at, symbol, strategy_version_id, input_hash, snapshot,
                     first_candle_ts, last_candle_ts, candle_count, candles_hash
                 )
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
                 ON CONFLICT (symbol, input_hash) DO NOTHING
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
                ],
            );

            const created = result.rows[0];

            if (created !== undefined) {
                return { id: created.id, created: true };
            }

            const existing = await query<{ id: number }>(
                'SELECT id FROM signal_snapshot WHERE symbol = $1 AND input_hash = $2',
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
                 WHERE symbol = $1
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
