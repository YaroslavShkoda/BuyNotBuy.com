import { describe, expect, it } from 'vitest';

import '../test-support/test-database.js';

import { runBackfill } from './backfill.service.js';
import { createCandleRepository } from './candle.repository.js';

import type { BackfillProgress } from './backfill.service.js';
import type { CandleSeriesKey } from './candle.repository.js';
import type { MarketDataProvider } from '../market/providers/market-data.provider.js';
import type { Candle } from '../types/market.js';

/**
 * A backfill is measured by what it can survive: an interruption, a second
 * run, a venue that repeats itself, and a page with one bar wrong in it. Each
 * of those is a separate test here because each has a different failure, and
 * the two that matter most are quiet — a job that stalls reports nothing, and a
 * history with a hole in it looks exactly like one without.
 */

const HOUR = 3_600_000;
const NEWEST = 1_700_000_000_000;

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

/**
 * A venue holding one long series, served one page at a time and honouring the
 * cursor — which is the contract a resumable backfill depends on.
 *
 * `pageCap` matters as much as the series does. A venue that answers a thousand
 * bars in one page makes every paging question invisible, and the paging is the
 * part that is hard: the cursor, the resume, the gap between pages. So the cap
 * is small and the series is longer than it.
 */
function venue(
    series: readonly Candle[],
    pageCap = Number.POSITIVE_INFINITY,
): MarketDataProvider & {
    calls: Array<{ limit: number; before: number | undefined }>;
} {
    const calls: Array<{ limit: number; before: number | undefined }> = [];

    return {
        name: 'binance',
        symbol: BTC.symbol,
        calls,
        getPrice: async () => ({ symbol: BTC.symbol, price: 100 }),
        getCandles: async () => [...series],
        getAttributedCandles: async () => ({
            venue: 'binance',
            symbol: BTC.symbol,
            candles: [...series],
        }),
        getHistoricalCandles: async (limit: number, before?: number) => {
            calls.push({ limit, before });

            const eligible =
                before === undefined
                    ? series
                    : series.filter((candle) => candle.timestamp < before);

            // Newest first, the way every venue answers, so a service that
            // forgets to sort is caught here rather than in the table.
            return eligible
                .slice(0, Math.min(limit, pageCap))
                .sort((a, b) => b.timestamp - a.timestamp)
                .map((candle) => ({ ...candle }));
        },
    };
}

/** `count` bars ending at `newest`, one per interval. */
function series(count: number, newest = NEWEST, step = HOUR): Candle[] {
    return Array.from({ length: count }, (_, index) =>
        bar(newest - index * step),
    );
}

const repository = createCandleRepository();
const now = () => NEWEST + 10 * HOUR;

describe('runBackfill', () => {
    it('fills a series to the target and stops there', async () => {
        const provider = venue(series(50), 10);

        const result = await runBackfill({
            key: BTC,
            until: NEWEST - 20 * HOUR,
            repository,
            provider,
            now,
            pageDelayMs: 0,
        });

        // The venue holds fifty bars; the target is twenty hours back. A run
        // that kept going would store all fifty, and the extra twenty-nine are
        // indistinguishable from history nobody asked for.
        expect(result.reason).toBe('target_reached');
        expect(await repository.count(BTC)).toBe(21);
        expect(result.total).toBe(21);
    });

    it('walks the cursor backwards instead of re-reading the present', async () => {
        const provider = venue(series(50), 10);

        await runBackfill({
            key: BTC,
            until: NEWEST - 20 * HOUR,
            repository,
            provider,
            now,
            pageDelayMs: 0,
        });

        const first = provider.calls[0]?.before;
        const second = provider.calls[1]?.before;

        // The first page asks from the present because the table is empty. Every
        // page after it must ask from something older, or the run re-reads the
        // same newest bars forever — a job that reports progress and can never
        // reach history.
        expect(first).toBeUndefined();
        expect(second).toBeTypeOf('number');
        expect(second ?? 0).toBeLessThan(first ?? NEWEST);
    });

    it('never asks the venue for the same bar twice', async () => {
        const provider = venue(series(50), 10);

        await runBackfill({
            key: BTC,
            until: NEWEST - 30 * HOUR,
            repository,
            provider,
            now,
            pageDelayMs: 0,
        });

        const cursors = provider.calls.map((call) => call.before ?? 'newest');

        expect(new Set(cursors).size).toBe(cursors.length);
    });

    it('resumes from what is stored, not from a counter it kept in memory', async () => {
        // A first run that stops halfway, with nothing remembered about it.
        const source = venue(series(50), 10);

        const interrupted = await runBackfill({
            key: BTC,
            until: NEWEST - 29 * HOUR,
            maxCandles: 15,
            repository,
            provider: source,
            now,
            pageDelayMs: 0,
        });

        expect(interrupted.reason).toBe('budget_exhausted');
        expect(await repository.count(BTC)).toBe(15);

        // A brand new process, with no memory of the run above.
        const resumed = venue(series(50), 10);
        const result = await runBackfill({
            key: BTC,
            until: NEWEST - 29 * HOUR,
            repository,
            provider: resumed,
            now,
            pageDelayMs: 0,
        });

        expect(result.oldestStored).toBe(NEWEST - 29 * HOUR);

        // The resumed run must not re-read what the first one stored: the
        // cursor is the oldest bar, so the first page it asks for ends below
        // that bar and nothing already stored is fetched again.
        expect(resumed.calls[0]?.before).toBe(NEWEST - 14 * HOUR);
        expect(await repository.count(BTC)).toBe(30);
    });

    it('costs one read when there is nothing left to do', async () => {
        await runBackfill({
            key: BTC,
            until: NEWEST - 25 * HOUR,
            repository,
            provider: venue(series(50), 10),
            now,
            pageDelayMs: 0,
        });

        const second = venue(series(50), 10);
        const result = await runBackfill({
            key: BTC,
            until: NEWEST - 25 * HOUR,
            repository,
            provider: second,
            now,
            pageDelayMs: 0,
        });

        // What makes it safe to schedule rather than something an operator has
        // to remember not to run twice.
        expect(second.calls).toHaveLength(0);
        expect(result.pages).toBe(0);
        expect(result.written).toBe(0);
    });

    it('stops when the venue runs out of history', async () => {
        const provider = venue(series(12));

        const result = await runBackfill({
            key: BTC,
            // A target far older than anything the venue holds, so the run has
            // to end on "no more bars" rather than on the target.
            until: NEWEST - 5_000 * HOUR,
            repository,
            provider,
            now,
            pageDelayMs: 0,
        });

        expect(result.reason).toBe('no_more_bars');
        expect(result.total).toBe(12);
    });

    it('reports progress after every page', async () => {
        const seen: BackfillProgress[] = [];

        await runBackfill({
            key: BTC,
            until: NEWEST - 25 * HOUR,
            repository,
            provider: venue(series(50), 10),
            onProgress: (progress) => seen.push(progress),
            now,
            pageDelayMs: 0,
        });

        expect(seen.length).toBeGreaterThan(1);
        expect(seen.every((entry) => entry.oldestStored !== null)).toBe(true);

        // The number that matters is the one that only goes down, and it is the
        // one a progress line should show.
        const oldest = seen.map((entry) => entry.oldestStored ?? 0);

        for (let index = 1; index < oldest.length; index += 1) {
            expect(oldest[index] ?? 0).toBeLessThan(oldest[index - 1] ?? 0);
        }

        expect(seen[seen.length - 1]?.done).toBe(true);
    });

    describe('validation', () => {
        it('drops a malformed bar and keeps the rest of its page', async () => {
            const good = series(10);
            const provider = venue([
                bar(NEWEST, { high: 10, low: 90 }),
                ...good,
            ]);

            const result = await runBackfill({
                key: BTC,
                // Older than every bar in the page, so the target filter is not
                // what this test is measuring.
                until: NEWEST - 20 * HOUR,
                repository,
                provider,
                now,
                pageDelayMs: 0,
            });

            // One bad bar in a thousand costs one bar, not the page. A backfill
            // that discarded whole pages over a single malformed response would
            // finish with a history nobody can see is missing pieces.
            expect(result.rejected).toBe(1);
            expect(result.written).toBe(10);
            expect(await repository.count(BTC)).toBe(10);
        });

        it('drops a bar from the future', async () => {
            const provider = venue([
                ...series(5),
                bar(NEWEST + 100 * HOUR),
            ]);

            const result = await runBackfill({
                key: BTC,
                // Older than every real bar, so the target filter is not what
                // is being measured here.
                until: NEWEST - 10 * HOUR,
                repository,
                provider,
                now,
                pageDelayMs: 0,
            });

            expect(result.rejected).toBe(1);
            expect(await repository.count(BTC)).toBe(5);
        });

        it('drops a bar the caller did not ask for, and says so', async () => {
            const provider = venue(series(20), 10);

            const result = await runBackfill({
                key: BTC,
                until: NEWEST - 14 * HOUR,
                repository,
                provider,
                now,
                pageDelayMs: 0,
            });

            // The page that crosses the target arrives with bars under it. Those
            // are counted as refused rather than stored, so "stopped at the
            // target" and "stopped near the target" cannot be confused by
            // whoever is looking at the numbers afterwards.
            expect(result.rejected).toBe(5);
            expect(await repository.count(BTC)).toBe(15);
        });

        it('ends the run when a page is entirely unusable and moves nothing', async () => {
            const provider = venue([bar(NEWEST, { high: 10, low: 90 })]);

            const result = await runBackfill({
                key: BTC,
                until: NEWEST - 50 * HOUR,
                repository,
                provider,
                now,
                pageDelayMs: 0,
            });

            // Better a short history than a run that never ends. A backfill is
            // a long job, and a loop that cannot exit is worse than one that
            // stops short and says so.
            expect(result.reason).toBe('no_more_bars');
            expect(result.pages).toBe(1);
        });

        it('ends the run when a venue ignores the cursor and repeats a page', async () => {
            // The other half of the guard. A page that is fine on its own terms
            // and simply repeats is the harder one to notice: every iteration
            // reports progress, every write succeeds, and the cursor never
            // moves. A backfill that ran that way for six hours would look like
            // a healthy job in a log.
            let served = 0;
            const provider = venue(series(50), 10);

            const stuck: MarketDataProvider = {
                ...provider,
                getHistoricalCandles: async () => {
                    served += 1;

                    return provider.getHistoricalCandles(10);
                },
            };

            const result = await runBackfill({
                key: BTC,
                until: NEWEST - 45 * HOUR,
                repository,
                provider: stuck,
                now,
                pageDelayMs: 0,
            });

            expect(result.reason).toBe('no_more_bars');
            expect(served).toBeLessThan(6);
        });
    });

    describe('idempotence', () => {
        it('re-running a finished backfill changes nothing', async () => {
            const first = await runBackfill({
                key: BTC,
                until: NEWEST - 15 * HOUR,
                repository,
                provider: venue(series(50), 10),
                now,
                pageDelayMs: 0,
            });

            const before = await repository.getRange(BTC, 0, NEWEST, {
                closedOnly: false,
            });

            const second = await runBackfill({
                key: BTC,
                until: NEWEST - 15 * HOUR,
                repository,
                provider: venue(series(50), 10),
                now,
                pageDelayMs: 0,
            });

            const after = await repository.getRange(BTC, 0, NEWEST, {
                closedOnly: false,
            });

            expect(first.written).toBe(16);
            expect(second.written).toBe(0);
            expect(after.map((row) => row.close)).toEqual(
                before.map((row) => row.close),
            );
        });

        it('keeps one row per bar however many times it is written', async () => {
            for (let run = 0; run < 3; run += 1) {
                await runBackfill({
                    key: BTC,
                    until: NEWEST - 10 * HOUR,
                    repository,
                    provider: venue(series(50), 10),
                    now,
                    pageDelayMs: 0,
                });
            }

            expect(await repository.count(BTC)).toBe(11);
        });

        it('keeps two venues apart, so a switch does not merge them', async () => {
            await runBackfill({
                key: BTC,
                until: NEWEST - 10 * HOUR,
                repository,
                provider: venue(series(50), 10),
                now,
                pageDelayMs: 0,
            });

            await runBackfill({
                key: { ...BTC, provider: 'bitget' },
                until: NEWEST - 10 * HOUR,
                repository,
                provider: {
                    ...venue(series(50), 10),
                    name: 'bitget',
                    symbol: BTC.symbol,
                },
                now,
                pageDelayMs: 0,
            });

            expect(await repository.count(BTC)).toBe(11);
            expect(await repository.count({ ...BTC, provider: 'bitget' })).toBe(11);
        });
    });

    it('waits between pages rather than asking for everything at once', async () => {
        const delays: number[] = [];

        await runBackfill({
            key: BTC,
            until: NEWEST - 25 * HOUR,
            repository,
            provider: venue(series(50), 10),
            now,
            pageDelayMs: 250,
            sleep: (ms) => {
                delays.push(ms);

                return Promise.resolve();
            },
        });

        // Ten thousand bars is ten thousand calls. Made in a burst, that is how
        // filling a table turns into an address ban; spaced, it is hours.
        expect(delays.length).toBeGreaterThan(0);
        expect(new Set(delays)).toEqual(new Set([250]));
    });
});
