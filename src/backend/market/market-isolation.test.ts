import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Cross-market isolation.
 *
 * The roadmap calls this the most valuable test class it has, and the reason
 * is that a market mixed up with another does not look broken. A BTC snapshot
 * served for an ETH request has the right number of candles, plausible prices
 * and a fresh timestamp; nothing on the dashboard reports a problem, and every
 * metric computed from it is wrong.
 *
 * Every test here therefore asserts on *which market* the answer belongs to,
 * not merely that an answer came back.
 */

const { mockCalls, mockAnyProviderAvailable, seriesFor } = vi.hoisted(() => {
    /**
     * Declared inside the hoisted block and returned from it, because the mock
     * factory needs it and the factory runs before the module body does. A
     * helper left in the body would be in its temporal dead zone there: a
     * ReferenceError at import, which is a file that fails to load rather than
     * a test that fails.
     */
    const seriesFor = (symbol: string, limit?: number) => {
        const count = limit ?? 300;
        // Anchored to now, because the series validator refuses a newest bar
        // more than two intervals old — and it should. A double dated 2023 is
        // not a series, it is a fixture that happens to be in the past, and
        // building one tests the freshness check instead of the cache.
        const newest = Date.now() - 60_000;

        return Array.from({ length: count }, (_, index) => {
            const open = (symbol === 'BTCUSDT' ? 80000 : 4000) + index;

            return {
                timestamp: newest - (count - 1 - index) * 3_600_000,
                open,
                high: open + 1,
                low: open - 1,
                close: open + 0.5,
                volume: 1,
            };
        });
    };

    return {
        seriesFor,
        mockCalls: [] as string[],
        mockAnyProviderAvailable: vi.fn(() => true),
    };
});

vi.mock('./market.provider.js', () => ({
    anyMarketProviderAvailable: mockAnyProviderAvailable,
    activeMarketVenue: vi.fn(() => 'binance'),
    /**
     * A provider is built *for* a market and answers for that market only —
     * which is why the service compares the symbol it was given against the one
     * that came back, and why this cannot return one shared stub. That check
     * was already in the service before the cache was keyed; it had nothing to
     * catch, because there was one market to catch it against.
     */
    marketProviderFor: vi.fn((symbol: string) => ({
        name: 'binance',
        symbol,
        getPrice: vi.fn(async () => ({ symbol, price: symbol === 'BTCUSDT' ? 80000 : 4000 })),
        getCandles: vi.fn(async (_limit?: number) => []),
        getAttributedCandles: vi.fn(async (limit?: number) => {
            mockCalls.push(symbol);

            return {
                venue: 'binance',
                symbol,
                candles: seriesFor(symbol, limit),
            };
        }),
        getHistoricalCandles: vi.fn(async () => []),
    })),
    marketDataProvider: { name: 'binance' },
}));

import { getMarketData, marketKey, resetMarketDataCache } from './market.service.js';

import { marketConfig } from '../config/market.config.js';

beforeEach(() => {
    resetMarketDataCache();
    mockAnyProviderAvailable.mockReturnValue(true);
    mockCalls.length = 0;
});

describe('the cache key', () => {
    it('separates two markets', () => {
        expect(marketKey({ instrument: 'BTCUSDT', interval: '1h' })).not.toBe(
            marketKey({ instrument: 'ETHUSDT', interval: '1h' }),
        );
    });

    it('separates two intervals of one market', () => {
        // Different bar counts, different ages, different series. Serving one
        // as the other is the same error as serving one market as another.
        expect(marketKey({ instrument: 'BTCUSDT', interval: '1h' })).not.toBe(
            marketKey({ instrument: 'BTCUSDT', interval: '4h' }),
        );
    });

    it('does not care how the ticker was cased', () => {
        expect(marketKey({ instrument: 'BTCUSDT', interval: '1h' })).toBe(
            marketKey({ instrument: 'btcusdt', interval: '1h' }),
        );
    });
});

describe('one market is never served another market data', () => {
    it('asks for the market it was given', async () => {
        await getMarketData({ instrument: 'ETHUSDT', interval: '1h' });

        expect(mockCalls).toEqual(['ETHUSDT']);
    });

    it('serves the second request from its own fetch, not the first cache', async () => {
        // The defect this whole file exists for. With one unkeyed cache the
        // second call finds a warm entry, returns the first market's candles
        // under the second market's name, and reports itself fresh.
        const first = await getMarketData({ instrument: 'BTCUSDT', interval: '1h' });
        const second = await getMarketData({ instrument: 'ETHUSDT', interval: '1h' });

        expect(second.data.candles).not.toEqual(first.data.candles);
    });

    it('carries the right symbol in the result', async () => {
        const result = await getMarketData({ instrument: 'ETHUSDT', interval: '1h' });

        expect(result.data.symbol).toBe('ETHUSDT');
    });

    it('still serves the same market from cache when asked twice', async () => {
        await getMarketData({ instrument: 'ETHUSDT', interval: '1h' });
        mockCalls.length = 0;

        await getMarketData({ instrument: 'ETHUSDT', interval: '1h' });

        expect(mockCalls).toEqual([]);
    });

    it('coalesces concurrent requests per market, not globally', async () => {
        // One market's shared promise must not become another's answer.
        const [btc, eth] = await Promise.all([
            getMarketData({ instrument: 'BTCUSDT', interval: '1h' }),
            getMarketData({ instrument: 'ETHUSDT', interval: '1h' }),
        ]);

        expect(btc.data.symbol).toBe('BTCUSDT');
        expect(eth.data.symbol).toBe('ETHUSDT');
    });

    it('coalesces two concurrent requests for the same market into one call', async () => {
        await Promise.all([
            getMarketData({ instrument: 'BTCUSDT', interval: '1h' }),
            getMarketData({ instrument: 'BTCUSDT', interval: '1h' }),
        ]);

        expect(mockCalls).toEqual(['BTCUSDT']);
    });
});

describe('the default, so a caller that names nothing still works', () => {
    it('uses the configured market', async () => {
        const result = await getMarketData();

        expect(result.data.symbol).toBe(marketConfig.symbol);
    });

    it('does not collide with an explicit request for a different market', async () => {
        await getMarketData();
        const other = await getMarketData({ instrument: 'ETHUSDT', interval: '1h' });

        expect(other.data.symbol).toBe('ETHUSDT');
    });
});

describe('properties', () => {
    it('answers every request with a snapshot of the market that was asked for', () => {
        fc.assert(
            fc.asyncProperty(
                fc.uniqueArray(fc.constantFrom('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'), {
                    minLength: 1,
                    maxLength: 4,
                }),
                async (symbols) => {
                    for (const symbol of symbols) {
                        resetMarketDataCache();
                        const result = await getMarketData({ instrument: symbol, interval: '1h' });

                        if (result.data.symbol !== symbol) {
                            return false;
                        }
                    }

                    return true;
                },
            ),
            { numRuns: 40 },
        );
    });

    it('keeps every market warm at once without them bleeding into each other', () => {
        // The case an unkeyed cache fails in the most convincing way: several
        // markets cached, each correct, and the fifth one wrong.
        fc.assert(
            fc.asyncProperty(
                fc.uniqueArray(fc.constantFrom('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'), {
                    minLength: 2,
                    maxLength: 4,
                }),
                async (symbols) => {
                    resetMarketDataCache();

                    for (const symbol of symbols) {
                        await getMarketData({ instrument: symbol, interval: '1h' });
                    }

                    for (const symbol of symbols) {
                        const cached = await getMarketData({ instrument: symbol, interval: '1h' });

                        if (cached.data.symbol !== symbol) {
                            return false;
                        }
                    }

                    return true;
                },
            ),
            { numRuns: 40 },
        );
    });
});
