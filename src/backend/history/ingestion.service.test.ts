import { afterEach, describe, expect, it, vi } from 'vitest';

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import '../test-support/test-database.js';

import { configuredSeries, ingestOnce } from './ingestion.service.js';
import { startIngestionScheduler } from '../services/ingestion.scheduler.js';
import { createCandleRepository } from './candle.repository.js';

import type { PollerLogger } from '../services/poller.js';
import type { CandleSeriesKey } from './candle.repository.js';
import type { MarketDataProvider } from '../market/providers/market-data.provider.js';
import type { Candle } from '../types/market.js';

/**
 * The table is the reference every later measurement is taken against, so what
 * lands in it and what stays out of it is worth pinning down exactly. The test
 * that matters most is the last one in this file: a forming bar is stored, on
 * purpose, and the point of the exercise is that a backtest still cannot see
 * it.
 */

const HOUR = 3_600_000;
/** Aligned to the hour, because a venue labels a bar by its opening instant. */
const NEWEST = 1_699_999_200_000;
/** Half an hour into the hour that opened at NEWEST. */
const AT = NEWEST + 30 * 60_000;

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
            candles: [...candles],
        }),
        getHistoricalCandles: async () => {
            provider.calls += 1;

            return [...candles];
        },
    };

    return provider;
}

/** Nine closed hours and the hour now forming. */
function rollingWindow(): Candle[] {
    return Array.from({ length: 10 }, (_, index) => bar(NEWEST - index * HOUR));
}

const repository = createCandleRepository();
const now = () => AT;

const silent: PollerLogger = {
    info: () => undefined,
    error: () => undefined,
    warn: () => undefined,
};

describe('ingestOnce', () => {
    it('stores the forming bar separately from the finished ones', async () => {
        const result = await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider: venue(rollingWindow()),
            now,
        });

        // The bar that opened at NEWEST closes at NEWEST + 1h, and "now" is
        // half an hour in. Everything below it is finished.
        expect(result.closedWritten).toBe(9);
        expect(result.formingWritten).toBe(1);
        expect(result.forming).toBe(NEWEST);
        expect(result.fetched).toBe(10);
    });

    it('stores the forming bar as forming, so a reader can leave it out', async () => {
        await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider: venue(rollingWindow()),
            now,
        });

        const all = await repository.getAfter(BTC, 0, 100, {
            closedOnly: false,
        });
        const closed = await repository.getAfter(BTC, 0, 100);

        expect(all).toHaveLength(10);
        expect(closed).toHaveLength(9);
        expect(all.filter((row) => row.isClosed)).toHaveLength(9);
    });

    it('finishes the bar when its hour passes, rather than writing it twice', async () => {
        await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider: venue(rollingWindow()),
            now,
        });

        // An hour later the bar that was forming has closed and a new one has
        // opened, so the venue's window has moved on by exactly one.
        const later = Array.from({ length: 10 }, (_, index) =>
            bar(NEWEST + HOUR - index * HOUR),
        );

        const result = await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider: venue(later),
            now: () => AT + 30 * 60_000,
        });

        // One bar promoted from forming to closed, one new forming bar, and the
        // nine older ones rewritten with the values they already had. If
        // promotion were a second row rather than a change to the first, the
        // hour would be counted twice by everything that follows it.
        expect(result.closedWritten).toBe(9);
        expect(result.formingWritten).toBe(1);
        expect(await repository.count(BTC, { closedOnly: false })).toBe(11);
        expect(await repository.count(BTC)).toBe(10);
    });

    it('does nothing when the venue has nothing to say', async () => {
        const result = await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider: venue([]),
            now,
        });

        expect(result).toEqual({
            written: 0,
            closedWritten: 0,
            formingWritten: 0,
            skipped: 0,
            forming: null,
            fetched: 0,
        });
    });

    it('runs again without changing the finished history', async () => {
        const provider = venue(rollingWindow());

        await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider,
            now,
        });
        await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider,
            now,
        });

        // A poller runs every minute against an hour of data. If the repeat
        // inserted a row, the table would grow forever and every read would pay
        // for it.
        expect(provider.calls).toBe(2);
        expect(await repository.count(BTC, { closedOnly: false })).toBe(10);
    });

    describe('what a measurement is allowed to see', () => {
        it('hides the forming bar from every default read', async () => {
            await ingestOnce({
                key: BTC,
                intervalMs: HOUR,
                repository,
                provider: venue(rollingWindow()),
                now,
            });

            const range = await repository.getRange(BTC, 0, AT);
            const latest = await repository.getLatest(BTC);
            const before = await repository.getBefore(BTC, AT, 10);
            const after = await repository.getAfter(BTC, 0, 10);

            // These are the reads a backtest or a statistic is written against.
            // None of them returns the bar whose close was still moving, and
            // none of them has to remember to ask.
            expect(range.map((row) => row.timestamp)).toEqual(
                Array.from({ length: 9 }, (_, index) => NEWEST - (9 - index) * HOUR),
            );
            expect(after.map((row) => row.timestamp)).toEqual(
                range.map((row) => row.timestamp),
            );

            // getBefore walks back from a point, so it is newest-first and its
            // first row is the bar the forming one is hiding.
            expect(before).toHaveLength(9);
            expect(before[0]?.timestamp).toBe(NEWEST - HOUR);

            // getLatest answers with one bar, and the bar it answers with is
            // the newest finished one — not the one on the chart.
            expect(latest?.timestamp).toBe(NEWEST - HOUR);
            expect(latest?.isClosed).toBe(true);
        });

        it('shows the forming bar only to a reader that asked for it', async () => {
            await ingestOnce({
                key: BTC,
                intervalMs: HOUR,
                repository,
                provider: venue(rollingWindow()),
                now,
            });

            const withForming = await repository.getRange(BTC, 0, AT, {
                closedOnly: false,
            });

            expect(withForming).toHaveLength(10);
            expect(withForming.at(-1)?.isClosed).toBe(false);
        });

        it('cannot be tricked into counting the forming bar as history', async () => {
            await ingestOnce({
                key: BTC,
                intervalMs: HOUR,
                repository,
                provider: venue(rollingWindow()),
                now,
            });

            // The count a backtest prints, and the count a dashboard prints,
            // are different questions and must not share an answer.
            expect(await repository.count(BTC)).toBe(9);
            expect(await repository.count(BTC, { closedOnly: false })).toBe(10);
        });
    });
});

describe('startIngestionScheduler', () => {
    it('returns nothing when it is switched off', () => {
        const scheduler = startIngestionScheduler({
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider: venue(rollingWindow()),
            now,
            logger: silent,
            pollEnabled: false,
        });

        // A timer keeps a process alive, so a script or a test that did not ask
        // for one must not get one.
        expect(scheduler).toBeNull();
    });

    it('polls several times per bar rather than once', async () => {
        const timers: number[] = [];
        const provider = venue(rollingWindow());

        const scheduler = startIngestionScheduler({
            key: BTC,
            intervalMs: HOUR,
            maxPeriodMs: HOUR,
            repository,
            provider,
            now,
            logger: silent,
            setTimer: (handler, ms) => {
                timers.push(ms);

                return setTimeout(handler, 0);
            },
        });

        await scheduler?.ingest();

        // Once an hour would mean the tick that misses the close loses that bar
        // for good, and the hole is indistinguishable from a quiet market.
        expect(timers.every((ms) => ms < HOUR)).toBe(true);
        expect(timers[0]).toBe(450_000);

        await scheduler?.stop();
    });

    it('keeps going when a cycle fails, and reports it', async () => {
        const errors: unknown[] = [];
        const failing: MarketDataProvider = {
            ...venue([]),
            getHistoricalCandles: async () => {
                throw new Error('provider is down');
            },
        };

        const scheduler = startIngestionScheduler({
            key: BTC,
            intervalMs: HOUR,
            repository,
            provider: failing,
            now,
            logger: {
                info: () => undefined,
                error: (_context, _message) => errors.push(_context),
                warn: () => undefined,
            },
            setTimer: () => 0,
            clearTimer: () => undefined,
        });

        await vi.waitFor(() => expect(scheduler?.completedRuns).toBeGreaterThan(0));
        await scheduler?.stop();

        // The poller exists precisely so that nobody is watching when the
        // provider is down, and a failure that stops it is the one failure it
        // must not have.
        expect(errors.length).toBeGreaterThan(0);
    });

    it('fills the series named by the configuration', () => {
        expect(configuredSeries().interval).toBeTypeOf('string');
        expect(configuredSeries().symbol).toBeTypeOf('string');
    });
});

describe('the venue a market is stored under', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    /**
     * `configuredVenueFor` is unit-tested where it lives, and that test passes
     * whether or not anything calls it. This one goes through the function the
     * five tables actually take their key from — because the first version of
     * this work was verified in exactly the wrong place and passed on the old
     * code without noticing.
     */
    async function seriesFor(env: Record<string, string>): Promise<{
        provider: string;
        symbol: string;
    }> {
        vi.resetModules();

        for (const [key, value] of Object.entries(env)) {
            vi.stubEnv(key, value);
        }

        const { configuredSeries: build } = await import('./ingestion.service.js');

        return build('ETHUSDT');
    }

    it('names the venue configured to serve the market, not the primary', async () => {
        // **This is the item.** `key.provider` was `marketConfig.provider`, which
        // is the venue for the market named by `marketConfig.symbol` and for no
        // other. So every table keyed on `provider, symbol, interval` — candles,
        // signal history, signal state, transitions, outcomes — recorded one
        // venue's prices under another venue's name, with no join anywhere able
        // to contradict it.
        const series = await seriesFor({
            MARKET_PROVIDER: 'binance',
            MARKET_SYMBOL: 'BTCUSDT',
            MARKET_VENUE_CAPABILITIES: 'binance=BTCUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h',
        });

        expect(series.symbol).toBe('ETHUSDT');
        expect(series.provider).toBe('bitget');
    });

    it('still names the primary for the primary market', async () => {
        // The default has to survive the fix, or every existing deployment
        // changes the series its history is filed under on upgrade.
        await seriesFor({
            MARKET_PROVIDER: 'binance',
            MARKET_SYMBOL: 'BTCUSDT',
            MARKET_VENUE_CAPABILITIES: 'binance=BTCUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h',
        });

        const { configuredSeries: build } = await import('./ingestion.service.js');

        expect(build().provider).toBe('binance');
    });
});

/**
 * Rule 8.3 as something that runs.
 *
 * The rule — a backtest must not see a bar that was still forming — is
 * enforced by the repository's default, which means it holds only for as long
 * as nobody passes the flag that turns it off. The readers that matter are the
 * ones a measurement is written against, and this scan is how a change to one
 * of them has to argue with the rule rather than quietly route around it.
 */
describe('a forming bar stays out of every measurement', () => {
    const BACKEND_ROOT = join(import.meta.dirname, '..');

    function sourceFiles(dir: string): string[] {
        return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const full = join(dir, entry.name);

            if (entry.isDirectory()) {
                return sourceFiles(full);
            }

            return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
                ? [full]
                : [];
        });
    }

    it('is not readable from a backtest or a statistics module', () => {
        const offenders: string[] = [];

        for (const area of ['backtest', 'indicators']) {
            for (const file of sourceFiles(join(BACKEND_ROOT, area))) {
                const source = readFileSync(file, 'utf8');

                if (/closedOnly\s*:\s*false/.test(source)) {
                    offenders.push(
                        `${relative(BACKEND_ROOT, file)} opts out of the closed-bar filter`,
                    );
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it('has no read that forgets the default', () => {
        const source = readFileSync(
            join(import.meta.dirname, 'candle.repository.ts'),
            'utf8',
        );

        // getLatest, getRange, getBefore, getAfter and count each resolve the
        // flag themselves. A sixth read added later without resolving it would
        // show up here as a mismatch rather than as a forming bar in a backtest.
        const resolved = source.match(/options\?\.closedOnly\s*\?\?\s*true/g) ?? [];

        expect(resolved).toHaveLength(5);
    });
});
