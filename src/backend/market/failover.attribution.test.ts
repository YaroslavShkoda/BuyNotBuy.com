import { beforeEach, describe, expect, it } from 'vitest';

import { FailoverProvider } from './failover.provider.js';
import { MarketDataError } from '../errors/market-data.error.js';
import { currentCandles } from '../test-support/candles.js';
import { marketConfig } from '../config/market.config.js';
import { resetMarketDataCache } from './market.service.js';

import type { MarketDataProvider } from './providers/market-data.provider.js';

/**
 * A fallback that is not labelled is a silent substitution, which is the one
 * outcome the failover must never produce: the two venues print different
 * numbers for the same hour, so an unlabelled switch is a fake market move
 * visible in every chart, every stored snapshot and every metric.
 */
function venue(
    name: string,
    behaviour: { fail?: string; price?: number } = {},
): { name: string; provider: MarketDataProvider } {
    // `fail` applies to every method, not just the price. A stub that refused
    // one entry point and answered another would be a venue that is neither up
    // nor down, and the chain under test would be proving nothing.
    const refuse = (): never => {
        throw new MarketDataError(behaviour.fail ?? 'refused', {
            code: 'MARKET_DATA_UNAVAILABLE',
        });
    };

    return {
        name,
        provider: {
            name,
            symbol: marketConfig.symbol,
            getPrice: async () => {
                if (behaviour.fail !== undefined) {
                    return refuse();
                }

                return {
                    symbol: marketConfig.symbol,
                    price: behaviour.price ?? 1,
                };
            },
            getCandles: async () => {
                if (behaviour.fail !== undefined) {
                    return refuse();
                }

                return [];
            },
            getHistoricalCandles: async () => {
                if (behaviour.fail !== undefined) {
                    return refuse();
                }

                return [];
            },
            getAttributedCandles: async () => {
                if (behaviour.fail !== undefined) {
                    return refuse();
                }

                return {
                    venue: name,
                    symbol: marketConfig.symbol,
                    candles: currentCandles(5),
                };
            },
        },
    };
}

describe('failover attribution', () => {
    beforeEach(() => {
        // The snapshot cache is process-wide; a leftover entry would satisfy
        // the first call of the next test from the previous one.
        resetMarketDataCache();
    });

    it('names the primary when it answers', async () => {
        const provider = new FailoverProvider(
            venue('binance', { price: 84_000 }),
            [venue('bitget', { price: 83_900 })],
        );

        const result = await provider.getAttributedCandles();

        expect(result.venue).toBe('binance');
        expect(result.symbol).toBe(marketConfig.symbol);
    });

    it('names the backup when the primary is down', async () => {
        const provider = new FailoverProvider(
            venue('binance', { fail: 'refused' }),
            [venue('bitget', { price: 83_900 })],
        );

        const result = await provider.getAttributedCandles();

        expect(result.venue).toBe('bitget');
        expect(result.candles).toHaveLength(5);
    });

    it('reports a switch so a caller can tell it from a market move', async () => {
        const provider = new FailoverProvider(
            venue('binance', { fail: 'refused' }),
            [venue('bitget')],
        );

        expect(provider.switched).toBe(false);

        await provider.getAttributedCandles();

        expect(provider.switched).toBe(true);
        expect(provider.activeVenue).toBe('bitget');
        expect(provider.venues).toEqual(['binance', 'bitget']);
    });

    it('trusts the venue a provider reports over its own name', async () => {
        // The wrapper is called `failover`, which is what it is and not which
        // venue answered. Preferring the wrapper's name would relabel a Bitget
        // snapshot as "failover" and lose the attribution entirely.
        const provider = new FailoverProvider(
            venue('binance', { fail: 'refused' }),
            [venue('bitget')],
        );

        expect(provider.name).toBe('failover');

        const result = await provider.getAttributedCandles();

        expect(result.venue).toBe('bitget');
    });

    it('names the primary ticker as the chain symbol, not that of the backup', async () => {
        const primary = venue('binance');
        const backup = {
            name: 'bitget',
            provider: {
                ...venue('bitget').provider,
                symbol: 'ETHUSDT',
                getAttributedCandles: async () => ({
                    venue: 'bitget',
                    symbol: 'ETHUSDT',
                    candles: [],
                }),
            },
        };

        const provider = new FailoverProvider(primary, [backup]);

        // The chain reports what it was asked for. A backup configured with a
        // different ticker is a legitimate setting, and the mismatch has to
        // stay visible as a mismatch rather than being relabelled.
        expect(provider.symbol).toBe(primary.provider.symbol);
    });

    it('reports every attempted venue and its code when all fail', async () => {
        const provider = new FailoverProvider(
            venue('binance', { fail: 'timeout' }),
            [venue('bitget', { fail: 'rate limited' })],
        );

        const error = await provider.getAttributedCandles().catch((caught) => caught);

        expect(error).toBeInstanceOf(MarketDataError);

        const cause = (error as MarketDataError).cause as {
            venues: string[];
            attempted: Array<{ venue: string; code: string | null }>;
        };

        expect(cause.venues).toEqual(['binance', 'bitget']);
        expect(cause.attempted).toEqual([
            { venue: 'binance', reason: expect.any(String), code: 'MARKET_DATA_UNAVAILABLE' },
            { venue: 'bitget', reason: expect.any(String), code: 'MARKET_DATA_UNAVAILABLE' },
        ]);
    });

    it('leaves no code rather than guessing one from the message', async () => {
        const provider = new FailoverProvider(
            {
                name: 'binance',
                provider: {
                    name: 'binance',
                    symbol: marketConfig.symbol,
                    getPrice: async () => {
                        throw new TypeError('fetch failed');
                    },
                    getCandles: async () => [],
                    getHistoricalCandles: async () => [],
                    getAttributedCandles: async () => {
                        throw new TypeError('fetch failed');
                    },
                },
            },
            [venue('bitget', { fail: 'down' })],
        );

        const error = await provider.getAttributedCandles().catch((caught) => caught);
        const cause = (error as MarketDataError).cause as {
            attempted: Array<{ venue: string; code: string | null }>;
        };

        // A code is read from the error, never inferred from its text, so a
        // plain `TypeError` produces null rather than a guess.
        expect(cause.attempted[0]?.code).toBeNull();
    });
});
