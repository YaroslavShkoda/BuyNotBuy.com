import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { requiredCandleCount } from '../config/indicator.config.js';
import { analysisPersistenceWork } from '../test-support/analysis-persistence-drain.js';
import { currentCandles } from '../test-support/candles.js';

const { mockMarketDataProvider, mockAnyProviderAvailable } = vi.hoisted(() => {
    const base = {
        getPrice: vi.fn(async () => ({
            symbol: 'BTCUSDT',
            price: 80000,
        })),
        getCandles: vi.fn(async (limit = 900) =>
            currentCandles(limit),
        ),
    };

    return {
        mockAnyProviderAvailable: vi.fn(() => true),
        mockMarketDataProvider: {
            ...base,
            getAttributedCandles: vi.fn(async (limit?: number) => ({
                venue: 'binance',
                symbol: 'BTCUSDT',                interval: '1h',
                candles: await base.getCandles(limit),
            })),
        },
    };
});

vi.mock('../market/market.provider.js', () => ({
    // The router hands the service a provider for the market it was asked
    // about. Every test here has one market, so it hands back the one stub —
    // the routing itself is exercised in capability.test.ts, where a wrong
    // answer is a property failure rather than a mistyped URL.
    marketProviderFor: () => mockMarketDataProvider,
    marketDataProvider: mockMarketDataProvider,
    anyMarketProviderAvailable: mockAnyProviderAvailable,
    activeMarketVenue: vi.fn(() => 'binance'),
}));

vi.mock('../history/signal-history.service.js', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

import { createApp } from '../app.js';
import { query } from '../db/pool.js';

async function closeContractApp(app: ReturnType<typeof Fastify>) {
    try {
        await analysisPersistenceWork.drain();
    } finally {
        await app.close();
    }
}

import {
    MarketAnalysisSchema,
    MarketDataSchema,
    PriceResponseSchema,
} from './schemas.js';

describe('API contract validation', () => {
    it('GET /api/analysis response passes schema', async () => {
        const app = Fastify();
        await app.register((await import('./routes/analysis')).analysisRoutes);

        const response = await app.inject({
            method: 'GET',
            url: '/api/analysis',
        });

        expect(response.statusCode).toBe(200);
        expect(() => MarketAnalysisSchema.parse(response.json())).not.toThrow();

        await closeContractApp(app);
    });

    it('GET /api/market response passes schema', async () => {
        const app = Fastify();
        await app.register((await import('./routes/market')).marketRoutes);

        const response = await app.inject({
            method: 'GET',
            url: '/api/market',
        });

        expect(response.statusCode).toBe(200);
        expect(() => MarketDataSchema.parse(response.json())).not.toThrow();

        await closeContractApp(app);
    });

    it('GET /api/price response passes schema', async () => {
        const app = Fastify();
        await app.register((await import('./routes/price')).priceRoutes);

        const response = await app.inject({
            method: 'GET',
            url: '/api/price',
        });

        expect(response.statusCode).toBe(200);
        expect(() => PriceResponseSchema.parse(response.json())).not.toThrow();

        await closeContractApp(app);
    });

    it('full app analysis response passes schema with default limit', async () => {
        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/analysis',
        });

        expect(response.statusCode).toBe(200);

        const body = response.json();
        // One momentum reading per closed candle the market layer delivered.
        expect(body.momentum.series.length).toBeGreaterThanOrEqual(
            requiredCandleCount(),
        );
        expect(() => MarketAnalysisSchema.parse(body)).not.toThrow();

        await closeContractApp(app);
    });

    it('finishes persistence delayed beyond the contract response before closing', async () => {
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((done) => { enter = done; });
        const gate = new Promise<void>((done) => { release = done; });
        const real = await vi.importActual<typeof import('../analysis/signal-snapshot.repository.js')>('../analysis/signal-snapshot.repository.js');
        const repository = real.getSignalSnapshotRepository();
        const record = repository.record.bind(repository);
        let finished = false;
        const delayed = vi.spyOn(repository, 'record').mockImplementationOnce(async (input) => {
            enter();
            await gate;
            const stored = await record(input);
            finished = true;
            return stored;
        });
        const app = createApp();
        let finishedBeforeClose = false;
        let snapshotsAtClose = -1;
        app.addHook('onClose', async () => {
            finishedBeforeClose = finished;
            snapshotsAtClose = Number((await query('SELECT count(*) AS n FROM signal_snapshot')).rows[0]?.n);
        });
        let closing: Promise<void> | undefined;
        try {
            const response = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(response.statusCode).toBe(200);
            expect(() => MarketAnalysisSchema.parse(response.json())).not.toThrow();
            await entered;
            closing = closeContractApp(app);
            expect(Number((await query('SELECT count(*) AS n FROM signal_snapshot')).rows[0]?.n)).toBe(0);
            release();
            await closing;
            expect(finishedBeforeClose).toBe(true);
            expect(snapshotsAtClose).toBe(1);
        } finally {
            release();
            await analysisPersistenceWork.drain();
            await (closing ?? app.close());
            delayed.mockRestore();
        }
    });
});
