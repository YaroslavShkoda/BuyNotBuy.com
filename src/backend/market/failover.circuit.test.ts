import { describe, expect, it, vi } from 'vitest';

import { MarketDataError } from '../errors/market-data.error.js';
import { ProviderError } from '../errors/provider.error.js';
import { FailoverProvider } from './failover.provider.js';

import type { MarketDataProvider } from './providers/market-data.provider.js';

/**
 * An open circuit is a refusal to this venue, not to the request.
 *
 * Worth a test of its own because the shape invites the opposite reading. A
 * breaker that has given up on a provider looks, from outside, like the whole
 * subsystem refusing — and "the breaker is open" and "every venue is
 * unavailable" produce the same visible symptom, so it is worth being explicit
 * that the failover still gets its turn.
 */
function refusing(venue: string, reason: string): MarketDataProvider {
    // The typed refusal the transport now throws, rather than a bare
    // `MarketDataError` with the fact buried in a `cause` bag. A fixture that
    // described the old shape would keep the old shape working by accident and
    // prove nothing about the one under test.
    const refuse = (): never => {
        throw new ProviderError('circuit_open', reason, {
            statusCode: 503,
            retryAfterSeconds: 30,
            context: { provider: venue },
        });
    };

    return {
        name: venue,
        symbol: 'BTCUSDT',
        getPrice: async () => refuse(),
        getCandles: async () => refuse(),
        getHistoricalCandles: async () => refuse(),
        getAttributedCandles: async () => refuse(),
    };
}

function answering(venue: string, price: number): MarketDataProvider {
    return {
        name: venue,
        symbol: 'BTCUSDT',
        getPrice: async () => ({ symbol: 'BTCUSDT', price }),
        getCandles: async () => [],
        getHistoricalCandles: async () => [],
        getAttributedCandles: async () => ({
            venue,
            symbol: 'BTCUSDT',
            candles: [],
        }),
    };
}

describe('failover across an open circuit', () => {
    it('still tries the backup when the primary circuit is open', async () => {
        const backup = answering('bitget', 81_000);

        const provider = new FailoverProvider(
            {
                name: 'binance',
                provider: refusing('binance', 'circuit open'),
            },
            [{ name: 'bitget', provider: backup }],
        );

        const price = await provider.getPrice();

        expect(price.price).toBe(81_000);
        expect(provider.activeVenue).toBe('bitget');
    });

    it('keeps the backup for the next request rather than re-probing the primary', async () => {
        const primary = vi.fn(
            async () => {
                throw new MarketDataError('circuit open', {
                    code: 'MARKET_DATA_UNAVAILABLE',
                    retryAfterSeconds: 30,
                    cause: { provider: 'binance', circuit: 'open' },
                });
            },
        );
        const backup = vi.fn(async () => ({ symbol: 'BTCUSDT', price: 81_000 }));

        const provider = new FailoverProvider(
            {
                name: 'binance',
                provider: {
                    name: 'binance',
                    symbol: 'BTCUSDT',
                    getPrice: primary,
                    getCandles: async () => [],
                    getHistoricalCandles: async () => [],
                    getAttributedCandles: async () => {
                        throw new MarketDataError('circuit open', {
                            code: 'MARKET_DATA_UNAVAILABLE',
                            retryAfterSeconds: 30,
                            cause: { provider: 'binance', circuit: 'open' },
                        });
                    },
                },
            },
            [
                {
                    name: 'bitget',
                    provider: {
                        name: 'bitget',
                        symbol: 'BTCUSDT',
                        getPrice: backup,
                        getCandles: async () => [],
                        getHistoricalCandles: async () => [],
                        getAttributedCandles: async () => ({
                            venue: 'bitget',
                            symbol: 'BTCUSDT',
                            candles: [],
                        }),
                    },
                },
            ],
        );

        await provider.getPrice();
        await provider.getPrice();

        // The point of the open breaker: a venue that is refusing connections
        // must not be re-tried on every poll, each attempt costing a full
        // timeout before the backup answers anyway. One attempt moved the
        // service onto the backup; the second request starts there.
        expect(primary).toHaveBeenCalledTimes(1);
        expect(backup).toHaveBeenCalledTimes(2);
    });

    it('reports every venue it tried when all of them refuse', async () => {
        const provider = new FailoverProvider(
            { name: 'binance', provider: refusing('binance', 'circuit open') },
            [{ name: 'bitget', provider: refusing('bitget', 'circuit open') }],
        );

        const error = await provider.getCandles().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ProviderError);

        const details = (error as ProviderError).details as {
            attempted: Array<{ venue: string; kind: string | null }>;
        };

        // A refusal of the chain's own making, from both venues. The kinds are
        // what say so — the message is the same whichever venue refused, which
        // is exactly why it cannot be the thing anyone reads.
        expect(details.attempted).toHaveLength(2);
        expect(details.attempted.map((entry) => entry.venue)).toEqual([
            'binance',
            'bitget',
        ]);
        expect(details.attempted.every((entry) => entry.kind === 'circuit_open'))
            .toBe(true);
    });
});
