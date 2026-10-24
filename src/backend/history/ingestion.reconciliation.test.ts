import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MarketDataProvider } from '../market/providers/market-data.provider.js';
import { startIngestionScheduler } from '../services/ingestion.scheduler.js';
import type { PollerLogger } from '../services/poller.js';
import {
    getTestPool,
    seedTestInstrument,
    truncateSignalTables,
} from '../test-support/test-database.js';
import type { Candle } from '../types/market.js';
import type { CandleSeriesKey } from './candle.repository.js';
import { createCandleRepository } from './candle.repository.js';
import { ingestOnce } from './ingestion.service.js';

/**
 * Reconciliation, not ceremony: the ingestion race recorded at the Stage 3
 * release gate - a manual `ingest()` crossing a timer cycle, two writers
 * racing the same bar rows, surfacing as `market_candles_provider_symbol_
 * interval_timestamp_key` under load and vanishing in isolation - is a
 * database-level property, so these tests drive real concurrent writers
 * against the real table and assert what is stored, not what was returned.
 *
 * The semantics pinned here are at-least-once delivery over an idempotent,
 * conflict-arbitrated upsert. No exactly-once claim is made or testable: a
 * provider may hand the same bar to two writers, and the table is what
 * decides which value wins and whether a finished bar may move again.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Hour-aligned, because a venue labels a bar by its opening instant. */
const BASE = 1_700_000_400_000 - (1_700_000_400_000 % HOUR);

const BTC: CandleSeriesKey = {
    provider: 'binance',
    symbol: 'BTCUSDT',
    interval: '1h',
};

function bar(timestamp: number, overrides: Partial<Candle> = {}): Candle {
    const close = overrides.close ?? 100;
    const open = overrides.open ?? close - 0.25;

    return {
        timestamp,
        open,
        high: overrides.high ?? Math.max(open, close) + 1,
        low: overrides.low ?? Math.min(open, close) - 1,
        close,
        volume: overrides.volume ?? 10,
    };
}

/** `count` closed bars, oldest first, unless a clock says otherwise. */
function window(count: number): Candle[] {
    return Array.from({ length: count }, (_unused, index) =>
        bar(BASE + index * HOUR),
    );
}

function venue(candles: readonly Candle[]): MarketDataProvider & {
    calls: number;
} {
    const provider = {
        name: 'binance',
        symbol: BTC.symbol,
        calls: 0,
        getPrice: async () => ({ symbol: BTC.symbol, price: 100 }),
        getCandles: async () => [...candles],
        getAttributedCandles: async () => ({
            venue: 'binance',
            symbol: BTC.symbol,
            interval: '1h' as const,
            candles: [...candles],
        }),
        getHistoricalCandles: async () => {
            provider.calls += 1;

            return [...candles];
        },
    };

    return provider;
}

const silent: PollerLogger = {
    info: () => undefined,
    error: () => undefined,
    warn: () => undefined,
};

beforeAll(async () => {
    await seedTestInstrument('BTCUSDT');
});

beforeEach(async () => {
    await truncateSignalTables();
});

describe('concurrent writers over one series', () => {
    it('store every bar once and raise no constraint error', async () => {
        const repository = createCandleRepository();
        const bars = window(40);
        const provider = venue(bars);
        // Past every bar's close, so all forty are finished from both
        // writers' point of view.
        const at = BASE + bars.length * HOUR + HOUR;
        const options = {
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider,
            now: () => at,
        };

        for (let round = 0; round < 6; round += 1) {
            const outcomes = await Promise.allSettled([
                ingestOnce(options),
                ingestOnce(options),
            ]);

            const rejections = outcomes.filter(
                (outcome): outcome is PromiseRejectedResult =>
                    outcome.status === 'rejected',
            );

            expect(
                rejections.map((rejection) => String(rejection.reason)),
                JSON.stringify(rejections.map((r) => String(r.reason))),
            ).toHaveLength(0);
        }

        const duplicates = await getTestPool().query(
            `SELECT timestamp, COUNT(*)::int AS n
             FROM market_candles
             WHERE provider = $1 AND symbol = $2 AND interval = $3
             GROUP BY timestamp
             HAVING COUNT(*) > 1`,
            [BTC.provider, BTC.symbol, BTC.interval],
        );

        expect(duplicates.rows).toHaveLength(0);
        expect(await repository.count(BTC, { closedOnly: false })).toBe(
            bars.length,
        );
    });

    it('never lets a racing writer reopen a finished bar', async () => {
        const repository = createCandleRepository();
        const bars = window(2);

        // Both hours stored as finished: the clock is past both closes.
        await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider: venue(bars),
            now: () => BASE + bars.length * HOUR + HOUR,
        });

        // The same window, but the newest hour is half-formed again - what a
        // poller cycle that started before the close offers, and exactly what
        // the loser of a race must not write over a finished bar.
        const formingClock = () => BASE + HOUR + 30 * MINUTE;

        const outcomes = await Promise.allSettled([
            ingestOnce({
                key: BTC,
                intervalMs: HOUR,
                repository,
                provider: venue(bars),
                now: formingClock,
            }),
            ingestOnce({
                key: BTC,
                intervalMs: HOUR,
                repository,
                provider: venue(bars),
                now: formingClock,
            }),
        ]);

        expect(
            outcomes.every((outcome) => outcome.status === 'fulfilled'),
        ).toBe(true);

        const stored = await repository.getRange(BTC, BASE, BASE + HOUR, {
            closedOnly: false,
        });
        const newest = stored.find((row) => row.timestamp === BASE + HOUR);

        expect(newest?.isClosed).toBe(true);
    });
});

describe('restart and gap recovery', () => {
    it('re-ingests idempotently and refills a gap a crash left behind', async () => {
        const bars = window(12);
        const at = BASE + bars.length * HOUR + HOUR;

        // The process before the restart, whatever it carried in memory.
        const before = createCandleRepository();
        await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            repository: before,
            provider: venue(bars),
            now: () => at,
        });

        // A restart is a new repository and a fresh read of the table - the
        // cursor lives in the rows, so the new writer re-stores what is
        // already correct rather than believing it remembers.
        const after = createCandleRepository();
        const rerun = await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            repository: after,
            provider: venue(bars),
            now: () => at,
        });

        expect(rerun.written).toBe(bars.length);
        expect(await after.count(BTC, { closedOnly: false })).toBe(
            bars.length,
        );

        // The crash lost one bar mid-hour. Nothing notices a hole until a
        // measurement is taken over it, so the refill has to come from the
        // same fetch-and-store path, not from a repair script.
        await getTestPool().query(
            `DELETE FROM market_candles
             WHERE provider = $1 AND symbol = $2 AND interval = $3
               AND timestamp = $4`,
            [BTC.provider, BTC.symbol, BTC.interval, BASE + 5 * HOUR],
        );

        expect(await after.count(BTC, { closedOnly: false })).toBe(
            bars.length - 1,
        );

        const refill = await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            repository: after,
            provider: venue(bars),
            now: () => at,
        });

        expect(refill.written).toBe(bars.length);
        expect(await after.count(BTC, { closedOnly: false })).toBe(
            bars.length,
        );

        const range = await after.getRange(BTC, BASE, BASE + (bars.length - 1) * HOUR, {
            closedOnly: true,
        });

        expect(range.map((row) => row.timestamp)).toEqual(
            bars.map((candle) => candle.timestamp),
        );
    });
});

describe('the scheduler flight', () => {
    it('carries a manual ingest and a scheduled cycle together, not in parallel', async () => {
        const repository = createCandleRepository();
        const bars = window(6);
        const provider = venue(bars);

        const scheduler = startIngestionScheduler({
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider,
            now: () => BASE + bars.length * HOUR + HOUR,
            logger: silent,
            // The timer never fires on its own; every cycle below is asked
            // for by hand, so the fetch count is the coalescing's answer.
            setTimer: () => 0,
        });

        if (scheduler === null) {
            throw new Error('the ingestion scheduler must start in this test');
        }

        try {
            const [first, second] = await Promise.all([
                scheduler.ingest(),
                scheduler.ingest(),
            ]);

            expect(provider.calls).toBe(1);
            expect(first.written).toBe(second.written);

            // The guard releases once the flight lands: the next ask runs a
            // real cycle instead of serving a snapshot for ever.
            await scheduler.ingest();
            expect(provider.calls).toBe(2);
        } finally {
            await scheduler.stop();
        }
    });
});
