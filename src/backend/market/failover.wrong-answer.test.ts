import Fastify from 'fastify';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderError } from '../errors/provider.error.js';
import { currentCandles } from '../test-support/candles.js';
import type { Candle } from '../types/market.js';
import { FailoverProvider } from './failover.provider.js';
import { getMarketData, resetMarketDataCache } from './market.service.js';
import type { MarketDataProvider } from './providers/market-data.provider.js';

/**
 * The wrong answer, arriving through the chain.
 *
 * The symbol and series checks in `market.service.ts` are tested against a
 * provider asked directly. What those tests cannot see is the case that only
 * exists **because** failover happened: the primary is down, the backup
 * answers, and the backup is wrong вЂ” a different ticker's series, or a series
 * with a hole in it. The refusal then has to survive the switch: nothing the
 * backup said may reach a caller or the cache, and the failure must name the
 * venue that actually produced it, because "failover" is the moment a wrong
 * answer is most likely and least expected.
 */

const state = vi.hoisted(() => ({
    /** Swapped by each test: what the backup does when the chain reaches it. */
    backup: null as MarketDataProvider | null,
}));

vi.mock('./market.provider.js', () => ({
    marketProviderFor: () => {
        const failingPrimary: MarketDataProvider = {
            name: 'binance',
            symbol: 'BTCUSDT',
            getPrice: vi.fn(async () => {
                throw new ProviderError('unavailable', 'binance is unreachable', { context: { provider: 'binance' } });
            }),
            getCandles: vi.fn(async () => {
                throw new ProviderError('unavailable', 'binance is unreachable', { context: { provider: 'binance' } });
            }),
            getAttributedCandles: vi.fn(async () => {
                throw new ProviderError('unavailable', 'binance is unreachable', {
                    context: { provider: 'binance' },
                });
            }),
            getHistoricalCandles: vi.fn(async () => {
                throw new ProviderError('unavailable', 'binance is unreachable', {
                    context: { provider: 'binance' },
                });
            }),
        };

        return new FailoverProvider(
            { name: 'binance', provider: failingPrimary },
            [{ name: 'bitget', provider: state.backup! }],
        );
    },
    marketDataProvider: { name: 'failover' },
    anyMarketProviderAvailable: vi.fn(() => true),
    activeMarketVenue: vi.fn(() => 'bitget'),
}));

const backupProvider = (answer: () => unknown): MarketDataProvider =>
    ({
        name: 'bitget',
        symbol: 'BTCUSDT',
        getPrice: vi.fn(async () => ({ symbol: 'BTCUSDT', price: 100 })),
        getCandles: vi.fn(async (limit = 900) => currentCandles(limit, 100)),
        getAttributedCandles: vi.fn(async () => answer()),
        getAttributedPrice: vi.fn(async () => ({
            venue: 'bitget',
            symbol: 'BTCUSDT',
            price: 100,
        })),
        getHistoricalCandles: vi.fn(async (limit = 900) => currentCandles(limit, 100)),
    }) as MarketDataProvider;

describe('a backup that answers wrongly during failover', () => {
    afterEach(() => {
        state.backup = null;
        resetMarketDataCache();
        vi.resetModules();
    });

    it('refuses a series for another asset instead of serving it under the requested name', async () => {
        state.backup = backupProvider(() => ({
            venue: 'bitget',
            symbol: 'ETHUSDT',
            interval: '1h',
            candles: currentCandles(900, 3000),
        }));

        // The refusal names the venue that answered and both tickers: an
        // operator reading the log must see that bitget spoke for ETHUSDT on
        // a BTCUSDT request, not that "a provider failed".
        await expect(getMarketData({ instrument: 'BTCUSDT', interval: '1h' }))
            .rejects
            .toMatchObject({
                code: 'MARKET_PROVIDER_ERROR',
                cause: {
                    provider: 'bitget',
                    requestedSymbol: 'BTCUSDT',
                    answeredSymbol: 'ETHUSDT',
                },
            });
    });

    it('refuses a broken series from the backup, naming the venue that sent it', async () => {
        const broken: Candle[] = currentCandles(900, 100);
        // One bar removed from the middle: a discontinuity the indicators
        // would step over and report a smooth, plausible number for.
        broken.splice(400, 1);

        state.backup = backupProvider(() => ({
            venue: 'bitget',
            symbol: 'BTCUSDT',
            interval: '1h',
            candles: broken,
        }));

        await expect(getMarketData({ instrument: 'BTCUSDT', interval: '1h' }))
            .rejects
            .toMatchObject({
                code: 'MARKET_PROVIDER_ERROR',
                cause: {
                    provider: 'bitget',
                    issue: 'has_gap',
                },
            });
    });

    it('leaves the cache empty of the refused answer, and serves a corrected backup next call', async () => {
        let attempts = 0;

        state.backup = backupProvider(() => {
            attempts += 1;

            return attempts === 1
                ? {
                      venue: 'bitget',
                      symbol: 'ETHUSDT',
                      interval: '1h',
                      candles: currentCandles(900, 3000),
                  }
                : {
                      venue: 'bitget',
                      symbol: 'BTCUSDT',
                      interval: '1h',
                      candles: currentCandles(900, 100),
                  };
        });

        await expect(
            getMarketData({ instrument: 'BTCUSDT', interval: '1h' }),
        ).rejects.toMatchObject({ code: 'MARKET_PROVIDER_ERROR' });

        // The refused payload was never cached: the next call reaches the
        // venue again and serves its corrected answer, rather than an empty
        // result or the previous failure.
        const recovered = await getMarketData({ instrument: 'BTCUSDT', interval: '1h' });

        expect(recovered.data.symbol).toBe('BTCUSDT');
        expect(recovered.data.price.price).toBeLessThan(2000);
        expect(recovered.provider).toBe('bitget');
        expect(attempts).toBe(2);
    });

    it('reaches a client as the typed 502, with no wrong answer in the body', async () => {
        state.backup = backupProvider(() => ({
            venue: 'bitget',
            symbol: 'ETHUSDT',
            interval: '1h',
            candles: currentCandles(900, 3000),
        }));

        const application = Fastify();
        const { registerErrorHandler } = await import('../api/error-handler.js');
        const { marketRoutes } = await import('../api/routes/market.js');

        registerErrorHandler(application);
        await application.register(marketRoutes);

        const response = await application.inject({
            method: 'GET',
            url: '/api/market',
        });

        expect(response.statusCode).toBe(502);

        const body = response.json() as { error: { code: string; message: string } };

        expect(body.error.code).toBe('MARKET_PROVIDER_ERROR');
        // The public envelope carries the class of the failure, never the
        // refused series: nothing about ETH reaches a BTC dashboard, even as
        // an error message.
        expect(response.body).not.toContain('3000');
        expect(response.body).not.toContain('ETHUSDT');

        await application.close();
    });
});
