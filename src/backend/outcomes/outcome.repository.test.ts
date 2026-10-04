import { describe, expect, it, beforeEach } from 'vitest';

import { createOutcomeRepository } from './outcome.repository.js';
import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';

import type { OutcomeRepository, SettleInput } from './outcome.repository.js';
import type { Candle } from '../types/market.js';
import type { Pool } from 'pg';

const HOUR = 3_600_000;
const BASE = 1_700_000_000_000;
const NOW = BASE + 100 * HOUR;
const KEY = { symbol: 'BTCUSDT', provider: 'binance', interval: '1h' };

let pool: Pool;
let repository: OutcomeRepository;

beforeEach(async () => {
    pool = getTestPool();
    await truncateSignalTables();
    repository = createOutcomeRepository(
        (text, values) => pool.query(text, values as unknown[]),
    );
});

/** One bar per hour, rising one percent. */
function rising(count: number, from = BASE): Candle[] {
    return Array.from({ length: count }, (_, index) => {
        const close = 100 * 1.01 ** index;

        return {
            timestamp: from + index * HOUR,
            open: close,
            high: close,
            low: close,
            close,
            volume: 1,
        };
    });
}

function settle(
    candles: Candle[],
    overrides: Partial<SettleInput> = {},
): Promise<Awaited<ReturnType<OutcomeRepository['settle']>>> {
    return repository.settle({
        key: KEY,
        stateId: 1,
        direction: 'LONG',
        entryTimestamp: BASE,
        entryPrice: 100,
        candles,
        now: NOW,
        ...overrides,
    });
}

describe('a measurement is stored once per horizon', () => {
    it('writes a row for every configured horizon', async () => {
        const rows = await settle(rising(200));

        // Seven horizons, seven rows. Columns per horizon would mean a
        // migration every time an operator wants to measure further out.
        expect(rows).toHaveLength(7);
        expect(rows.map((row) => row.horizonBars)).toEqual([
            1, 3, 6, 12, 24, 48, 72,
        ]);
    });

    it('finishes a measurement in place rather than counting it twice', async () => {
        // A signal unresolved on the first run and resolved on the second is
        // the same measurement finished. A report that counted both would
        // report a hit rate over a sample twice the size of the real one.
        const partial = await settle(rising(10));
        const complete = await settle(rising(200));

        const unresolved = partial.find((row) => row.horizonBars === 72);
        const resolved = complete.find((row) => row.horizonBars === 72);

        expect(unresolved?.verdict).toBe('unknown');
        expect(resolved?.verdict).toBe('correct');
        expect(resolved?.id).toBe(unresolved?.id);

        const stored = await pool.query<{ total: number }>(
            'SELECT COUNT(*)::int AS total FROM signal_outcome',
        );

        expect(stored.rows[0]?.total).toBe(7);
    });

    it('never rewrites a resolved measurement, however the series changed', async () => {
        // The first run sees a rising market and resolves every horizon as
        // `correct`. The second run re-settles the same signal over a rewritten
        // series — the shape a backfill produces. The stored answer is history:
        // a report recomputed a month later must not quietly disagree with the
        // one that was already acted on.
        await settle(rising(200));

        const rewritten = rising(200).map((candle) => ({
            ...candle,
            close: candle.close * 0.5,
            open: candle.open * 0.5,
            high: candle.high * 0.5,
            low: candle.low * 0.5,
        }));

        const attempted = await settle(rewritten, { now: NOW + HOUR });
        expect(attempted).toHaveLength(0);

        const stored = await pool.query<{
            verdict: string;
            return_fraction: number | null;
        }>(
            `SELECT verdict, return_fraction FROM signal_outcome
             WHERE horizon_bars = 1`,
        );

        expect(stored.rows).toHaveLength(1);
        expect(stored.rows[0]?.verdict).toBe('correct');
        expect(stored.rows[0]?.return_fraction ?? 0).toBeGreaterThan(0);
    });

    it('keeps two series apart', async () => {
        await settle(rising(200));
        await settle(rising(200), {
            key: { symbol: 'BTCUSDT', provider: 'binance', interval: '4h' },
        });

        const hourly = await repository.forSeries(
            KEY,
            12,
        );
        const fourHourly = await repository.forSeries(
            { ...KEY, interval: '4h' },
            12,
        );

        expect(hourly).toHaveLength(1);
        expect(fourHourly).toHaveLength(1);
    });

    it('writes nothing at all when one horizon cannot be written', async () => {
        // Nine rows for one signal is a table whose totals do not add up. A
        // measurement is a whole, not a set of parts that can be half-saved.
        const broken = createOutcomeRepository(
            (text, values) => pool.query(text, values as unknown[]),
            async (work) => {
                const client = await pool.connect();

                try {
                    await client.query('BEGIN');

                    let written = 0;
                    const fake = {
                        query: async (text: string, values?: readonly unknown[]) => {
                            written += 1;

                            if (written === 3) {
                                throw new Error('outcome table unavailable');
                            }

                            return client.query(text, values as unknown[]);
                        },
                    };

                    try {
                        return await work(fake as never);
                    } finally {
                        await client.query('ROLLBACK');
                    }
                } finally {
                    client.release();
                }
            },
        );

        await expect(
            broken.settle({
                key: KEY,
                stateId: 1,
                direction: 'LONG',
                entryTimestamp: BASE,
                entryPrice: 100,
                candles: rising(200),
                now: NOW,
            }),
        ).rejects.toThrow(/outcome table unavailable/);

        const stored = await pool.query<{ total: number }>(
            'SELECT COUNT(*)::int AS total FROM signal_outcome',
        );

        expect(stored.rows[0]?.total).toBe(0);
    });
});

describe('a stored measurement is the one that was computed', () => {
    it('keeps the return signed in the direction of the signal', async () => {
        // Falls one percent a bar, from the same 100 the long tests enter at.
        const falling = Array.from({ length: 200 }, (_, index) => {
            const close = 100 * 0.99 ** index;

            return {
                timestamp: BASE + index * HOUR,
                open: close,
                high: close,
                low: close,
                close,
                volume: 1,
            };
        });

        const rows = await settle(falling, { direction: 'SHORT' });
        const one = rows.find((row) => row.horizonBars === 1);

        // A short into a falling market made money. A table storing raw returns
        // makes every reader reconstruct the direction on its own, and the ones
        // that forget get the sign wrong.
        expect(one?.verdict).toBe('correct');
        expect(one?.returnFraction ?? 0).toBeGreaterThan(0);
    });

    it('keeps the entry and the bar it was measured against', async () => {
        const rows = await settle(rising(200));
        const three = rows.find((row) => row.horizonBars === 3);

        expect(three?.entryTimestamp).toBe(BASE);
        expect(three?.entryPrice).toBe(100);
        expect(three?.exitTimestamp).toBe(BASE + 3 * HOUR);
    });

    it('carries the market the signal came from down onto the measurement', async () => {
        const rows = await settle(rising(200), {
            regime: 'NORMAL/TREND_UP',
            dataQuality: 0.88,
        });

        // Grouping a performance table by regime is the only way to find out
        // which regimes the system is right in, and a regime that stops at the
        // history table is a column nothing can query.
        expect(rows[0]?.regime).toBe('NORMAL/TREND_UP');
        expect(rows[0]?.dataQuality).toBe(0.88);
    });

    it('refuses a verdict the rest of the system cannot interpret', async () => {
        await expect(
            pool.query(
                `INSERT INTO signal_outcome (
                    symbol, provider, interval, direction, verdict, horizon_bars,
                    entry_timestamp, entry_price, created_at, updated_at
                 ) VALUES ('BTCUSDT', 'binance', '1h', 'LONG', 'MAYBE', 1,
                           $1, 100, $1, $1)`,
                [BASE],
            ),
        ).rejects.toThrow();
    });
});

describe('the settlement queue', () => {
    const KEY = { symbol: 'BTCUSDT', provider: 'binance', interval: '1h' };

    it('counts each waiting signal once, not once per horizon', async () => {
        await settle(rising(2));

        // What the scan needs is "the bars are ready for this signal". A count of
        // seven rows for the same one would report a backlog seven times too
        // large, and a gauge read as a backlog is read as work remaining.
        expect(await repository.countUnresolved(KEY)).toBe(1);
    });

    it('leaves a settled signal out', async () => {
        await settle(rising(200));

        expect(await repository.countUnresolved(KEY)).toBe(0);
    });

    it('counts only the market it was asked about', async () => {
        // **The finding, at the level it lives.** Two markets, one waiting signal
        // each. The old query had no predicate on the market, so BTCUSDT's scan
        // read both — and with `LIMIT` and `ORDER BY symbol` it decided
        // alphabetically which markets were counted at all, so the same market
        // reported a different backlog depending on what else existed.
        await settle(rising(2));
        await settle(rising(2), {
            key: { symbol: 'ETHUSDT', provider: 'binance', interval: '1h' },
        });

        expect(await repository.countUnresolved(KEY)).toBe(1);
        expect(
            await repository.countUnresolved({
                symbol: 'ETHUSDT',
                provider: 'binance',
                interval: '1h',
            }),
        ).toBe(1);
        expect(
            await repository.countUnresolved({
                symbol: 'SOLUSDT',
                provider: 'binance',
                interval: '1h',
            }),
        ).toBe(0);
    });

    it('does not count another market under a venue that serves both', async () => {
        // Same venue, different market. The market is part of the key for a
        // reason, and this is the assertion that keeps it part of it.
        await settle(rising(2), {
            key: { symbol: 'ETHUSDT', provider: 'binance', interval: '1h' },
        });

        expect(
            await repository.countUnresolved({
                symbol: 'ETHUSDT',
                provider: 'binance',
                interval: '1h',
            }),
        ).toBe(1);
        expect(
            await repository.countUnresolved({
                symbol: 'BTCUSDT',
                provider: 'binance',
                interval: '1h',
            }),
        ).toBe(0);
    });
});

describe('retention', () => {
    it('drops a measurement whose signal is gone', async () => {
        await settle(rising(200));

        const removed = await repository.deleteBefore(NOW + 1);

        expect(removed).toBe(7);
    });

    it('keeps a measurement whose signal is still current', async () => {
        await pool.query(
            `INSERT INTO signal_state (
                symbol, provider, interval, direction, status,
                price, confidence, published_at, candle_timestamp,
                created_at, updated_at
             ) VALUES ('BTCUSDT', 'binance', '1h', 'LONG', 'ACTIVE',
                       100, 70, $1, $1, $1, $1)`,
            [NOW],
        );

        const rows = await settle(rising(200), { stateId: 1 });
        expect(rows[0]?.stateId).toBe(1);

        // A cutoff before the live signal was last touched. A signal updated
        // after the cutoff is current, and the measurements belonging to it
        // are the ones a report about it is built from.
        const removed = await repository.deleteBefore(NOW - HOUR);

        // Deleting the history of a signal that is still live would leave the
        // live row with no record of how it got there.
        expect(removed).toBe(0);
    });

    it('drops a measurement whose signal stopped being touched first', async () => {
        await pool.query(
            `INSERT INTO signal_state (
                symbol, provider, interval, direction, status,
                price, confidence, published_at, candle_timestamp,
                created_at, updated_at
             ) VALUES ('BTCUSDT', 'binance', '1h', 'LONG', 'ACTIVE',
                       100, 70, $1, $1, $1, $1)`,
            [NOW],
        );

        await settle(rising(200), { stateId: 1 });

        // Same rows, a cutoff after the live signal was last touched. Age
        // alone is the rule here, and the guard only ever rescues a signal
        // that is still being updated.
        expect(await repository.deleteBefore(NOW + HOUR)).toBe(7);
    });
});
