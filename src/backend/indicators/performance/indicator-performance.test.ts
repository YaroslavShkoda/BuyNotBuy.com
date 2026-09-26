import { describe, expect, it, vi } from 'vitest';

import { createIndicatorVoteRepository } from './indicator-vote.repository.js';
import {
    recordIndicatorVotes,
    settleForwardReturns,
    summarizeIndicatorPerformance,
} from './indicator-performance.service.js';

import type { Candle } from '../../types/market.js';
import type { MarketAnalysis } from '../../types/analysis.js';
import type {
    IndicatorVote,
    IndicatorVoteRepository,
    UnsettledVote,
} from './indicator-performance.types.js';

const HOUR_MS = 3_600_000;
const HOUR = 1_700_000_000_000;

/**
 * A repository for one test, talking to the file's own PostgreSQL schema.
 *
 * The test setup truncates `indicator_vote` before every test, so there is
 * nothing to tear down: no file to delete, no handle to close, and a
 * repository abandoned half way through a failed test leaves no state behind
 * for the next one. That is also why a fresh instance per test is free — the
 * singleton exists so production shares one pool, not to make tests share rows.
 */
function openRepository(maxEntries = 720): IndicatorVoteRepository {
    return createIndicatorVoteRepository({ maxEntries });
}

function candlesFrom(entries: [hoursFromStart: number, close: number][]): Candle[] {
    return entries.map(([offset, close]) => ({
        timestamp: HOUR + offset * HOUR_MS,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
    }));
}

function vote(overrides: Partial<IndicatorVote> = {}): IndicatorVote {
    return {
        timestamp: HOUR,
        symbol: 'BTCUSDT',
        indicator: 'EMA 300',
        signal: 'LONG',
        weight: 0.5,
        price: 100,
        fwdReturns: {},
        ...overrides,
    };
}

/**
 * The shape a repository hands back for a vote that still owes a horizon.
 * Built by a helper so the mocks below stay about the failure, not the shape.
 */
function unsettled(overrides: Partial<UnsettledVote> = {}): UnsettledVote {
    return {
        symbol: 'BTCUSDT',
        timestamp: HOUR,
        indicator: 'EMA 300',
        price: 100,
        signal: 'LONG',
        pending: ['1h'],
        ...overrides,
    };
}

function settle(
    repository: IndicatorVoteRepository,
    candles: Candle[],
): ReturnType<typeof settleForwardReturns> {
    return settleForwardReturns(
        'BTCUSDT',
        candles,
        undefined,
        undefined,
        repository,
    );
}

function analysisWith(
    indicators: MarketAnalysis['signal']['indicators'],
    price = 100,
    timestamp = HOUR,
): MarketAnalysis {
    return {
        timestamp,
        price,
        indicators: {
            ema300: 90,
            stochastic: 10,
            momentum: 1,
            atr: 0.015,
            rsi: 52.5,
            macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
        },
        signal: {
            signal: 'LONG',
            confidence: 60,
            reason: 'предложенный набор',
            indicators,
        },
        momentum: { period: 100, current: 1, series: [] },
        divergence: { bullish: null, bearish: null },
        periods: {
            ema: 300,
            stochastic: 100,
            momentum: 100,
            atr: 14,
            rsi: 14,
            macdFast: 12,
            macdSlow: 26,
            macdSignal: 9,
        },
    };
}

describe('indicator vote storage', () => {
    it('keeps one row per indicator per hour', async () => {
        const repository = openRepository();

        await repository.record([
            vote({ indicator: 'EMA 300' }),
            vote({ indicator: 'Стохастик', signal: 'SHORT' }),
            vote({ indicator: 'Momentum 100', signal: 'NEUTRAL' }),
        ]);

        await expect(repository.count('BTCUSDT')).resolves.toBe(3);

        const stored = await repository.list('BTCUSDT', 10);

        expect(stored.map((item) => item.indicator).sort()).toEqual([
            'EMA 300',
            'Momentum 100',
            'Стохастик',
        ]);
    });

    it('stores each indicator separately from the consensus', async () => {
        const repository = openRepository();

        // One consensus number cannot say which of the three earned it.
        await recordIndicatorVotes(
            analysisWith([
                { key: 'ema', name: 'EMA 300', signal: 'LONG', reason: 'a', weight: 0.8 },
                { key: 'stochastic', name: 'Стохастик', signal: 'NEUTRAL', reason: 'b', weight: 0 },
                { key: 'momentum', name: 'Momentum 100', signal: 'LONG', reason: 'c', weight: 0.4 },
            ]),
            'BTCUSDT',
            undefined,
            repository,
        );

        const stored = await repository.list('BTCUSDT', 10);

        expect(stored).toHaveLength(3);
        // Stored by key, not by label. The label carries the period, so storing
        // it would start a new series the first time the period changed and
        // leave every earlier vote stranded under the old name.
        expect(
            stored.find((item) => item.indicator === 'stochastic')?.signal,
        ).toBe('NEUTRAL');
        expect(
            stored.find((item) => item.indicator === 'ema')?.weight,
        ).toBeCloseTo(0.8, 10);
        expect(
            stored.some((item) => item.indicator === 'EMA 300'),
        ).toBe(false);
    });

    it('keeps a failing store from breaking the analysis path', async () => {
        const failing: IndicatorVoteRepository = {
            record: vi.fn().mockRejectedValue(new Error('database is locked')),
            list: vi.fn().mockResolvedValue([]),
            listUnsettled: vi.fn().mockResolvedValue([]),
            settle: vi.fn().mockResolvedValue(undefined),
            count: vi.fn().mockResolvedValue(0),
        };

        const logger = { warn: vi.fn() };

        // Production fires this off with `void` and never awaits it, so the
        // property that matters is not that it does not throw but that it
        // never rejects: an unhandled rejection there would take the process
        // down over a reading nobody was waiting for anyway.
        await expect(
            recordIndicatorVotes(
                analysisWith([
                    { key: 'ema', name: 'EMA 300', signal: 'LONG', reason: 'a', weight: 1 },
                ]),
                'BTCUSDT',
                logger,
                failing,
            ),
        ).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'indicator_vote_record_failed' }),
            'indicator_vote_record_failed',
        );
    });

    it('leaves forward returns unset until the horizon closes', async () => {
        const repository = openRepository();

        await repository.record([vote()]);

        // Zero would be indistinguishable from a vote that predicted nothing.
        expect((await repository.list('BTCUSDT', 10))[0]?.fwdReturns).toEqual({});
    });

    it('replaces a vote when a later reading of the same hour arrives', async () => {
        const repository = openRepository();

        await repository.record([
            vote({ signal: 'NEUTRAL', weight: 0, timestamp: HOUR + 60_000 }),
        ]);
        await repository.record([
            vote({ signal: 'LONG', weight: 0.9, timestamp: HOUR + 120_000 }),
        ]);

        const stored = await repository.list('BTCUSDT', 10);

        expect(stored).toHaveLength(1);
        expect(stored[0]?.signal).toBe('LONG');
        expect(stored[0]?.weight).toBeCloseTo(0.9, 10);
    });

    it('never lets a late older reading overwrite a fresher one', async () => {
        const repository = openRepository();

        await repository.record([vote({ signal: 'LONG', timestamp: HOUR + 120_000 })]);
        await repository.record([vote({ signal: 'SHORT', timestamp: HOUR + 60_000 })]);

        expect((await repository.list('BTCUSDT', 10))[0]?.signal).toBe('LONG');
    });
});

describe('forward return settlement', () => {
    it('does not settle a horizon that has not closed yet', async () => {
        const repository = openRepository();

        await repository.record([vote({ timestamp: HOUR })]);

        // The window stops one hour in: the 4h and 24h candles are not here.
        const summary = await settle(repository, candlesFrom([[0, 100], [1, 110]]));

        expect(summary.settled).toBe(1);
        // Two horizons are still owed, so the vote has not finished.
        expect(summary.stillPending).toBe(1);

        const stored = await repository.list('BTCUSDT', 10);

        expect(stored[0]?.fwdReturns['1h']).toBeCloseTo(0.1 - 0.002, 10);
        expect(stored[0]?.fwdReturns['4h']).toBeUndefined();
        expect(stored[0]?.fwdReturns['24h']).toBeUndefined();
    });

    it('signs the return by the direction of the vote', async () => {
        const repository = openRepository();

        await repository.record([vote({ signal: 'SHORT', timestamp: HOUR })]);

        await settle(repository, candlesFrom([[0, 100], [1, 90]]));

        // A correct short is a positive result, so longs and shorts can be
        // averaged together instead of cancelling out.
        expect((await repository.list('BTCUSDT', 10))[0]?.fwdReturns['1h']).toBeCloseTo(
            0.1 - 0.002,
            10,
        );
    });

    it('makes a correct call that cannot cover its costs a loss', async () => {
        const repository = openRepository();

        await repository.record([vote({ signal: 'LONG', timestamp: HOUR })]);

        // The price rose 0.1%, and a round trip costs 0.2%.
        await settle(repository, candlesFrom([[0, 100], [1, 100.1]]));

        const value = (await repository.list('BTCUSDT', 10))[0]?.fwdReturns['1h'];

        expect(value).toBeDefined();
        expect(value ?? 0).toBeLessThan(0);
    });

    it('settles every indicator of an hour against its own direction', async () => {
        const repository = openRepository();

        await repository.record([
            vote({ indicator: 'EMA 300', signal: 'LONG' }),
            vote({ indicator: 'Стохастик', signal: 'SHORT' }),
        ]);

        await settle(repository, candlesFrom([[0, 100], [1, 110]]));

        const stored = await repository.list('BTCUSDT', 10);

        expect(stored).toHaveLength(2);

        // The same price move is a gain for the long and a loss for the
        // short. Giving both the same number would make the comparison
        // circular, since the price rise is the only fact either had.
        expect(
            stored.find((item) => item.indicator === 'EMA 300')?.fwdReturns['1h'],
        ).toBeCloseTo(0.1 - 0.002, 10);
        expect(
            stored.find((item) => item.indicator === 'Стохастик')?.fwdReturns['1h'],
        ).toBeCloseTo(-0.1 - 0.002, 10);
    });

    it('keeps a disagreement from being resolved in favour of one side', async () => {
        const repository = openRepository();

        await repository.record([
            vote({ indicator: 'EMA 300', signal: 'LONG', timestamp: HOUR }),
            vote({ indicator: 'Momentum 100', signal: 'SHORT', timestamp: HOUR }),
            vote({ indicator: 'Стохастик', signal: 'LONG', timestamp: HOUR }),
        ]);

        // One collapsed entry per hour would carry whichever signal happened
        // to be read first, and the minority verdict would vanish.
        expect(
            (await repository.listUnsettled('BTCUSDT', 10)).map((item) => item.signal),
        ).toEqual(expect.arrayContaining(['LONG', 'SHORT']));

        await settle(repository, candlesFrom([[0, 100], [1, 110]]));

        const byIndicator = new Map(
            (await repository.list('BTCUSDT', 10)).map((item) => [item.indicator, item]),
        );

        expect(byIndicator.get('EMA 300')?.fwdReturns['1h']).toBeGreaterThan(0);
        expect(byIndicator.get('Стохастик')?.fwdReturns['1h']).toBeGreaterThan(0);
        expect(byIndicator.get('Momentum 100')?.fwdReturns['1h']).toBeLessThan(0);
    });

    it('never settles the same horizon twice', async () => {
        const repository = openRepository();

        await repository.record([vote({ timestamp: HOUR })]);

        const candles = candlesFrom([[0, 100], [1, 110]]);

        await settle(repository, candles);

        // A later price must not rewrite history: the 1h return is whatever
        // the market did one hour after the vote, forever.
        const second = await settle(repository, candlesFrom([[0, 100], [1, 50]]));

        // The vote is still owed the other two horizons, so it comes back round
        // and the settled one is not even looked at a second time.
        expect(second.examined).toBe(1);
        expect(second.settled).toBe(0);
        expect(second.stillPending).toBe(1);

        expect((await repository.list('BTCUSDT', 10))[0]?.fwdReturns['1h']).toBeCloseTo(
            0.1 - 0.002,
            10,
        );
    });

    it('settles a neutral vote to zero rather than judging it', async () => {
        const repository = openRepository();

        await repository.record([vote({ signal: 'NEUTRAL', timestamp: HOUR })]);

        await settle(repository, candlesFrom([[0, 100], [1, 200]]));

        // The indicator made no prediction, so it is neither right nor wrong.
        expect((await repository.list('BTCUSDT', 10))[0]?.fwdReturns['1h']).toBe(0);
    });

    it('leaves a vote alone when the price it stored is unusable', async () => {
        const repository = openRepository();

        await repository.record([vote({ price: 0, timestamp: HOUR })]);

        await settle(repository, candlesFrom([[0, 100], [1, 110]]));

        // Dividing by the vote price would produce a meaningless number that
        // then looked like data.
        expect((await repository.list('BTCUSDT', 10))[0]?.fwdReturns['1h']).toBeUndefined();
        expect((await settle(repository, candlesFrom([[0, 100], [1, 110]]))).stillPending).toBe(1);
    });

    it('skips a return that is not a finite number', async () => {
        const repository = openRepository();

        await repository.record([vote({ timestamp: HOUR })]);

        // NaN and Infinity can only arrive from a price that is not a price.
        // Writing one would store a value the summary would then average in as
        // though it were a measurement.
        await repository.settle('BTCUSDT', [
            { timestamp: HOUR, indicator: 'EMA 300', returns: { '1h': Number.NaN } },
        ]);

        expect((await repository.list('BTCUSDT', 10))[0]?.fwdReturns['1h']).toBeUndefined();
    });

    it('does nothing when there is nothing unsettled', async () => {
        const repository = openRepository();

        await expect(settle(repository, candlesFrom([[0, 100]]))).resolves.toEqual({
            examined: 0,
            settled: 0,
            stillPending: 0,
        });
    });

    it('survives a store that cannot be read', async () => {
        const failing: IndicatorVoteRepository = {
            record: vi.fn().mockResolvedValue(undefined),
            list: vi.fn().mockResolvedValue([]),
            listUnsettled: vi.fn().mockRejectedValue(new Error('database is locked')),
            settle: vi.fn().mockResolvedValue(undefined),
            count: vi.fn().mockResolvedValue(0),
        };

        const logger = { warn: vi.fn() };

        await expect(
            settleForwardReturns('BTCUSDT', [], undefined, logger, failing),
        ).resolves.toEqual({ examined: 0, settled: 0, stillPending: 0 });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'indicator_vote_read_failed' }),
            'indicator_vote_read_failed',
        );
    });

    it('keeps the pending horizons when a settlement cannot be written', async () => {
        const failing: IndicatorVoteRepository = {
            record: vi.fn().mockResolvedValue(undefined),
            list: vi.fn().mockResolvedValue([]),
            listUnsettled: vi.fn().mockResolvedValue([unsettled()]),
            settle: vi.fn().mockRejectedValue(new Error('database is locked')),
            count: vi.fn().mockResolvedValue(0),
        };

        const logger = { warn: vi.fn() };

        const summary = await settleForwardReturns(
            'BTCUSDT',
            candlesFrom([[0, 100], [1, 110]]),
            undefined,
            logger,
            failing,
        );

        // Reporting a success that was never written would make the next
        // cycle skip the work again.
        expect(summary.settled).toBe(0);
        expect(summary.stillPending).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'indicator_vote_settle_failed' }),
            'indicator_vote_settle_failed',
        );
    });
});

describe('performance summary', () => {
    it('counts only the votes that had an opinion', async () => {
        const repository = openRepository();

        await repository.record([
            vote({ signal: 'LONG', timestamp: HOUR, fwdReturns: { '1h': 0.01 } }),
            vote({ signal: 'NEUTRAL', timestamp: HOUR + HOUR_MS, fwdReturns: { '1h': 0.05 } }),
        ]);

        const [performance] = await summarizeIndicatorPerformance(
            'BTCUSDT',
            ['1h'],
            repository,
        );

        // Counting abstentions would let an indicator look excellent precisely
        // because it rarely spoke.
        expect(performance?.samples).toBe(1);
        expect(performance?.averageReturn).toBeCloseTo(0.01, 10);
        expect(performance?.hitRate).toBe(1);
    });

    it('reports nothing for a horizon nothing has settled yet', async () => {
        const repository = openRepository();

        await repository.record([vote({ fwdReturns: { '1h': 0.01 } })]);

        expect(await summarizeIndicatorPerformance('BTCUSDT', ['24h'], repository)).toEqual(
            [],
        );
    });

    it('separates the horizons into their own rows', async () => {
        const repository = openRepository();

        await repository.record([
            vote({ fwdReturns: { '1h': 0.01, '4h': 0.03, '24h': -0.02 } }),
        ]);

        const summary = await summarizeIndicatorPerformance(
            'BTCUSDT',
            ['1h', '4h', '24h'],
            repository,
        );

        expect(summary.map((item) => item.horizon).sort()).toEqual(['1h', '24h', '4h']);
        expect(
            summary.find((item) => item.horizon === '4h')?.averageReturn,
        ).toBeCloseTo(0.03, 10);
        expect(summary.find((item) => item.horizon === '24h')?.hitRate).toBe(0);
    });

    it('keeps one row per indicator so they can be told apart', async () => {
        const repository = openRepository();

        await repository.record([
            vote({ indicator: 'EMA 300', fwdReturns: { '1h': 0.01 } }),
            vote({ indicator: 'Стохастик', fwdReturns: { '1h': -0.01 } }),
        ]);

        const summary = await summarizeIndicatorPerformance(
            'BTCUSDT',
            ['1h'],
            repository,
        );

        expect(summary).toHaveLength(2);
        expect(summary.find((item) => item.indicator === 'EMA 300')?.hitRate).toBe(1);
        expect(summary.find((item) => item.indicator === 'Стохастик')?.hitRate).toBe(0);
    });

    it('tracks the spread as well as the mean', async () => {
        const repository = openRepository();

        await repository.record([
            vote({ timestamp: HOUR, fwdReturns: { '1h': 0.08 } }),
            vote({ timestamp: HOUR + HOUR_MS, fwdReturns: { '1h': -0.03 } }),
        ]);

        const [performance] = await summarizeIndicatorPerformance(
            'BTCUSDT',
            ['1h'],
            repository,
        );

        // A mean of +2.5% says nothing about a spread from −3% to +8%.
        expect(performance?.averageReturn).toBeCloseTo(0.025, 10);
        expect(performance?.best).toBeCloseTo(0.08, 10);
        expect(performance?.worst).toBeCloseTo(-0.03, 10);
    });

    it('says nothing at all when no vote has been recorded', async () => {
        const repository = openRepository();

        expect(
            await summarizeIndicatorPerformance('BTCUSDT', ['1h', '4h', '24h'], repository),
        ).toEqual([]);
    });
});
