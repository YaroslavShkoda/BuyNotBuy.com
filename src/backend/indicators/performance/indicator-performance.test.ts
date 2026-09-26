import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
} from './indicator-performance.types.js';
import type { ForwardHorizon } from './indicator-performance.types.js';

const HOUR_MS = 3_600_000;
const HOUR = 1_700_000_000_000;

const temporaryDirectories: string[] = [];
const openRepositories: IndicatorVoteRepository[] = [];

function temporaryDatabasePath(): string {
    const directory = mkdtempSync(join(tmpdir(), 'indicator-votes-'));
    temporaryDirectories.push(directory);

    const nested = join(directory, 'nested');
    mkdirSync(nested, { recursive: true });

    return join(nested, 'votes.db');
}

function openRepository(maxEntries = 720): IndicatorVoteRepository {
    const repository = createIndicatorVoteRepository({
        databasePath: temporaryDatabasePath(),
        maxEntries,
    });

    // Tracked so a failing test cannot leave a handle open: Windows then
    // refuses to delete the directory and the next test sees the fallout.
    openRepositories.push(repository);

    return repository;
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
    },    };
}

afterEach(() => {
    while (openRepositories.length > 0) {
        openRepositories.pop()?.close();
    }

    while (temporaryDirectories.length > 0) {
        const directory = temporaryDirectories.pop();

        if (directory !== undefined) {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

describe('indicator vote storage', () => {
    it('keeps one row per indicator per hour', () => {
        const repository = openRepository();

        repository.record([
            vote({ indicator: 'EMA 300' }),
            vote({ indicator: 'Стохастик', signal: 'SHORT' }),
            vote({ indicator: 'Momentum 100', signal: 'NEUTRAL' }),
        ]);

        expect(repository.count('BTCUSDT')).toBe(3);

        const stored = repository.list('BTCUSDT', 10);

        expect(stored.map((item) => item.indicator).sort()).toEqual([
            'EMA 300',
            'Momentum 100',
            'Стохастик',
        ]);

        repository.close();
    });

    it('stores each indicator separately from the consensus', () => {
        const repository = openRepository();

        // One consensus number cannot say which of the three earned it.
        recordIndicatorVotes(
            analysisWith([
                { key: 'ema' as const,
                name: 'EMA 300', signal: 'LONG', reason: 'a', weight: 0.8 },
                { key: 'stochastic' as const,
                name: 'Стохастик', signal: 'NEUTRAL', reason: 'b', weight: 0 },
                { key: 'momentum' as const,
                name: 'Momentum 100', signal: 'LONG', reason: 'c', weight: 0.4 },
            ]),
            'BTCUSDT',
            undefined,
            repository,
        );

        const stored = repository.list('BTCUSDT', 10);

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

        repository.close();
    });

    it('keeps a failing store from breaking the analysis path', () => {
        const failing: IndicatorVoteRepository = {
            record: () => {
                throw new Error('database is locked');
            },
            list: () => [],
            listUnsettled: () => [],
            settle: () => {},
            count: () => 0,
            close: () => {},
        };

        const logger = { warn: vi.fn() };

        expect(() =>
            recordIndicatorVotes(
                analysisWith([
                    { key: 'ema' as const,
                name: 'EMA 300', signal: 'LONG', reason: 'a', weight: 1 },
                ]),
                'BTCUSDT',
                logger,
                failing,
            ),
        ).not.toThrow();

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'indicator_vote_record_failed' }),
            'indicator_vote_record_failed',
        );
    });

    it('leaves forward returns unset until the horizon closes', () => {
        const repository = openRepository();

        repository.record([vote()]);

        // Zero would be indistinguishable from a vote that predicted nothing.
        expect(repository.list('BTCUSDT', 10)[0]?.fwdReturns).toEqual({});

        repository.close();
    });

    it('replaces a vote when a later reading of the same hour arrives', () => {
        const repository = openRepository();

        repository.record([
            vote({ signal: 'NEUTRAL', weight: 0, timestamp: HOUR + 60_000 }),
        ]);
        repository.record([
            vote({ signal: 'LONG', weight: 0.9, timestamp: HOUR + 120_000 }),
        ]);

        const stored = repository.list('BTCUSDT', 10);

        expect(stored).toHaveLength(1);
        expect(stored[0]?.signal).toBe('LONG');
        expect(stored[0]?.weight).toBeCloseTo(0.9, 10);

        repository.close();
    });

    it('never lets a late older reading overwrite a fresher one', () => {
        const repository = openRepository();

        repository.record([vote({ signal: 'LONG', timestamp: HOUR + 120_000 })]);
        repository.record([vote({ signal: 'SHORT', timestamp: HOUR + 60_000 })]);

        expect(repository.list('BTCUSDT', 10)[0]?.signal).toBe('LONG');

        repository.close();
    });
});

describe('forward return settlement', () => {
    it('does not settle a horizon that has not closed yet', () => {
        const repository = openRepository();

        repository.record([vote({ timestamp: HOUR })]);

        // The window stops one hour in: the 4h and 24h candles are not here.
        const summary = settle(repository, candlesFrom([[0, 100], [1, 110]]));

        expect(summary.settled).toBe(1);
        // Two horizons are still owed, so the vote has not finished.
        expect(summary.stillPending).toBe(1);

        const stored = repository.list('BTCUSDT', 10);

        expect(stored[0]?.fwdReturns['1h']).toBeCloseTo(0.1 - 0.002, 10);
        expect(stored[0]?.fwdReturns['4h']).toBeUndefined();
        expect(stored[0]?.fwdReturns['24h']).toBeUndefined();

        repository.close();
    });

    it('signs the return by the direction of the vote', () => {
        const repository = openRepository();

        repository.record([vote({ signal: 'SHORT', timestamp: HOUR })]);

        settle(repository, candlesFrom([[0, 100], [1, 90]]));

        // A correct short is a positive result, so longs and shorts can be
        // averaged together instead of cancelling out.
        expect(repository.list('BTCUSDT', 10)[0]?.fwdReturns['1h']).toBeCloseTo(
            0.1 - 0.002,
            10,
        );

        repository.close();
    });

    it('makes a correct call that cannot cover its costs a loss', () => {
        const repository = openRepository();

        repository.record([vote({ signal: 'LONG', timestamp: HOUR })]);

        // The price rose 0.1%, and a round trip costs 0.2%.
        settle(repository, candlesFrom([[0, 100], [1, 100.1]]));

        const value = repository.list('BTCUSDT', 10)[0]?.fwdReturns['1h'];

        expect(value).toBeDefined();
        expect(value ?? 0).toBeLessThan(0);

        repository.close();
    });

    it('settles every indicator of an hour against its own direction', () => {
        const repository = openRepository();

        repository.record([
            vote({ indicator: 'EMA 300', signal: 'LONG' }),
            vote({ indicator: 'Стохастик', signal: 'SHORT' }),
        ]);

        settle(repository, candlesFrom([[0, 100], [1, 110]]));

        const stored = repository.list('BTCUSDT', 10);

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

        repository.close();
    });

    it('keeps a disagreement from being resolved in favour of one side', () => {
        const repository = openRepository();

        repository.record([
            vote({ indicator: 'EMA 300', signal: 'LONG', timestamp: HOUR }),
            vote({ indicator: 'Momentum 100', signal: 'SHORT', timestamp: HOUR }),
            vote({ indicator: 'Стохастик', signal: 'LONG', timestamp: HOUR }),
        ]);

        // One collapsed entry per hour would carry whichever signal happened
        // to be read first, and the minority verdict would vanish.
        expect(repository.listUnsettled('BTCUSDT', 10).map((item) => item.signal)).toEqual(
            expect.arrayContaining(['LONG', 'SHORT']),
        );

        settle(repository, candlesFrom([[0, 100], [1, 110]]));

        const byIndicator = new Map(
            repository.list('BTCUSDT', 10).map((item) => [item.indicator, item]),
        );

        expect(byIndicator.get('EMA 300')?.fwdReturns['1h']).toBeGreaterThan(0);
        expect(byIndicator.get('Стохастик')?.fwdReturns['1h']).toBeGreaterThan(0);
        expect(byIndicator.get('Momentum 100')?.fwdReturns['1h']).toBeLessThan(0);

        repository.close();
    });

    it('never settles the same horizon twice', () => {        const repository = openRepository();

        repository.record([vote({ timestamp: HOUR })]);

        const candles = candlesFrom([[0, 100], [1, 110]]);

        settle(repository, candles);

        // A later price must not rewrite history: the 1h return is whatever
        // the market did one hour after the vote, forever.
        settle(repository, candlesFrom([[0, 100], [1, 50]]));

        expect(repository.list('BTCUSDT', 10)[0]?.fwdReturns['1h']).toBeCloseTo(
            0.1 - 0.002,
            10,
        );

        repository.close();
    });

    it('settles a neutral vote to zero rather than judging it', () => {
        const repository = openRepository();

        repository.record([vote({ signal: 'NEUTRAL', timestamp: HOUR })]);

        settle(repository, candlesFrom([[0, 100], [1, 200]]));

        // The indicator made no prediction, so it is neither right nor wrong.
        expect(repository.list('BTCUSDT', 10)[0]?.fwdReturns['1h']).toBe(0);

        repository.close();
    });

    it('leaves a vote alone when the price it stored is unusable', () => {
        const repository = openRepository();

        repository.record([vote({ price: 0, timestamp: HOUR })]);

        settle(repository, candlesFrom([[0, 100], [1, 110]]));

        // Dividing by the vote price would produce a meaningless number that
        // then looked like data.
        expect(repository.list('BTCUSDT', 10)[0]?.fwdReturns['1h']).toBeUndefined();
        expect(settle(repository, candlesFrom([[0, 100], [1, 110]])).stillPending).toBe(1);

        repository.close();
    });

    it('does nothing when there is nothing unsettled', () => {
        const repository = openRepository();

        expect(settle(repository, candlesFrom([[0, 100]]))).toEqual({
            examined: 0,
            settled: 0,
            stillPending: 0,
        });

        repository.close();
    });

    it('survives a store that cannot be read', () => {
        const failing: IndicatorVoteRepository = {
            record: () => {},
            list: () => [],
            listUnsettled: () => {
                throw new Error('database is locked');
            },
            settle: () => {},
            count: () => 0,
            close: () => {},
        };

        const logger = { warn: vi.fn() };

        expect(() =>
            settleForwardReturns('BTCUSDT', [], undefined, logger, failing),
        ).not.toThrow();

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'indicator_vote_read_failed' }),
            'indicator_vote_read_failed',
        );
    });

    it('keeps the pending horizons when a settlement cannot be written', () => {
        const failing: IndicatorVoteRepository = {
            record: () => {},
            list: () => [],
            listUnsettled: () => [
                {
                    symbol: 'BTCUSDT',
                    timestamp: HOUR,
                    indicator: 'EMA 300',
                    price: 100,
                    signal: 'LONG',
                    pending: ['1h'] as ForwardHorizon[],
                },
            ],
            settle: () => {
                throw new Error('database is locked');
            },
            count: () => 0,
            close: () => {},
        };

        const summary = settleForwardReturns(
            'BTCUSDT',
            candlesFrom([[0, 100], [1, 110]]),
            undefined,
            { warn: vi.fn() },
            failing,
        );

        // Reporting a success that was never written would make the next
        // cycle skip the work again.
        expect(summary.settled).toBe(0);
        expect(summary.stillPending).toBe(1);
    });
});

describe('performance summary', () => {
    it('counts only the votes that had an opinion', () => {
        const repository = openRepository();

        repository.record([
            vote({ signal: 'LONG', timestamp: HOUR, fwdReturns: { '1h': 0.01 } }),
            vote({ signal: 'NEUTRAL', timestamp: HOUR + HOUR_MS, fwdReturns: { '1h': 0.05 } }),
        ]);

        const [performance] = summarizeIndicatorPerformance(
            'BTCUSDT',
            ['1h'],
            repository,
        );

        // Counting abstentions would let an indicator look excellent precisely
        // because it rarely spoke.
        expect(performance?.samples).toBe(1);
        expect(performance?.averageReturn).toBeCloseTo(0.01, 10);
        expect(performance?.hitRate).toBe(1);

        repository.close();
    });

    it('reports nothing for a horizon nothing has settled yet', () => {
        const repository = openRepository();

        repository.record([vote({ fwdReturns: { '1h': 0.01 } })]);

        expect(summarizeIndicatorPerformance('BTCUSDT', ['24h'], repository)).toEqual(
            [],
        );

        repository.close();
    });

    it('separates the horizons into their own rows', () => {
        const repository = openRepository();

        repository.record([
            vote({ fwdReturns: { '1h': 0.01, '4h': 0.03, '24h': -0.02 } }),
        ]);

        const summary = summarizeIndicatorPerformance(
            'BTCUSDT',
            ['1h', '4h', '24h'],
            repository,
        );

        expect(summary.map((item) => item.horizon).sort()).toEqual(['1h', '24h', '4h']);
        expect(
            summary.find((item) => item.horizon === '4h')?.averageReturn,
        ).toBeCloseTo(0.03, 10);
        expect(summary.find((item) => item.horizon === '24h')?.hitRate).toBe(0);

        repository.close();
    });

    it('keeps one row per indicator so they can be told apart', () => {
        const repository = openRepository();

        repository.record([
            vote({ indicator: 'EMA 300', fwdReturns: { '1h': 0.01 } }),
            vote({ indicator: 'Стохастик', fwdReturns: { '1h': -0.01 } }),
        ]);

        const summary = summarizeIndicatorPerformance(
            'BTCUSDT',
            ['1h'],
            repository,
        );

        expect(summary).toHaveLength(2);
        expect(summary.find((item) => item.indicator === 'EMA 300')?.hitRate).toBe(1);
        expect(summary.find((item) => item.indicator === 'Стохастик')?.hitRate).toBe(0);

        repository.close();
    });

    it('tracks the spread as well as the mean', () => {
        const repository = openRepository();

        repository.record([
            vote({ timestamp: HOUR, fwdReturns: { '1h': 0.08 } }),
            vote({ timestamp: HOUR + HOUR_MS, fwdReturns: { '1h': -0.03 } }),
        ]);

        const [performance] = summarizeIndicatorPerformance(
            'BTCUSDT',
            ['1h'],
            repository,
        );

        // A mean of +2.5% says nothing about a spread from −3% to +8%.
        expect(performance?.averageReturn).toBeCloseTo(0.025, 10);
        expect(performance?.best).toBeCloseTo(0.08, 10);
        expect(performance?.worst).toBeCloseTo(-0.03, 10);

        repository.close();
    });

    it('says nothing at all when no vote has been recorded', () => {
        const repository = openRepository();

        expect(
            summarizeIndicatorPerformance('BTCUSDT', ['1h', '4h', '24h'], repository),
        ).toEqual([]);

        repository.close();
    });
});
