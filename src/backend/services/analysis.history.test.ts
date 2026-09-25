import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../history/signal-history.repository', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('../history/signal-history.repository')
    >();

    const memoryRepository = actual.createSignalHistoryRepository({
        databasePath: ':memory:',
        maxEntries: 720,
    });

    return {
        createSignalHistoryRepository: actual.createSignalHistoryRepository,
        getSignalHistoryRepository: vi.fn(() => memoryRepository),
    };
});

import { analyzeMarket } from './analysis.service';
import * as marketService from '../market/market.service';
import { MarketDataError } from '../errors/market-data.error';
import {
    createSignalHistoryRepository,
    getSignalHistoryRepository,
} from '../history/signal-history.repository';

import type { SignalHistoryRepository } from '../history/signal-history.repository';
import type { MockInstance } from 'vitest';

const marketDataFixture = {
    price: {
        symbol: 'BTCUSDT',
        price: 200,
    },
    candles: Array.from(
        { length: 300 },
        (_, index) => ({
            timestamp: index,
            open: 100,
            high: 100 + index,
            low: 100,
            close: 100 + index,
            volume: 1000,
        }),
    ),
};

describe('analysis → signal history integration', () => {
    let marketDataSpy: MockInstance;

    beforeEach(() => {
        marketDataSpy = vi.spyOn(marketService, 'getMarketData')
            .mockResolvedValue(marketDataFixture);

        // Fresh in-memory database per test so recorded entries never leak
        // between tests.
        const freshRepository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        vi.mocked(getSignalHistoryRepository)
            .mockImplementation(() => freshRepository);
    });

    afterEach(() => {
        marketDataSpy.mockRestore();
    });

    it('records a successful analysis into signal history', async () => {
        const analysis = await analyzeMarket();

        const entries = getSignalHistoryRepository().list('BTCUSDT', 10);

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            timestamp: analysis.timestamp,
            symbol: 'BTCUSDT',
            signal: 'SHORT',
            consensus: 67,
            price: 200,
        });
    });

    it('does not record history when the analysis fails', async () => {
        marketDataSpy.mockRejectedValueOnce(
            new MarketDataError('upstream unavailable'),
        );

        await expect(analyzeMarket()).rejects.toBeInstanceOf(MarketDataError);

        expect(
            getSignalHistoryRepository().list('BTCUSDT', 10),
        ).toHaveLength(0);
    });

    it('keeps the analysis working when history persistence fails', async () => {
        const failingRepository: SignalHistoryRepository = {
            record: () => {
                throw new Error('history storage unavailable');
            },
            list: () => [],
            close: () => {},
        };

        vi.mocked(getSignalHistoryRepository)
            .mockReturnValueOnce(failingRepository);

        const analysis = await analyzeMarket();

        expect(analysis.price).toBe(200);
        expect(analysis.signal.signal).toBe('SHORT');
    });

    it('does not create duplicates for concurrent analyses in the same hour', async () => {
        vi.useFakeTimers({
            toFake: ['Date'],
            now: new Date('2026-01-15T12:30:00Z'),
        });

        try {
            const [first, second] = await Promise.all([
                analyzeMarket(),
                analyzeMarket(),
            ]);

            expect(first.timestamp).toBe(second.timestamp);
        } finally {
            vi.useRealTimers();
        }

        expect(
            getSignalHistoryRepository().list('BTCUSDT', 10),
        ).toHaveLength(1);
    });
});
