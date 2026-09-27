import { describe, expect, it, vi } from 'vitest';

import { FailoverProvider } from './failover.provider.js';
import { ProviderError } from '../errors/provider.error.js';

import type { MarketDataProvider, ProviderCandles } from './providers/market-data.provider.js';
import type { AssetPrice, Candle } from '../types/market.js';

/**
 * The chain's own failure, and what it tells a caller about the venues.
 *
 * "No provider could answer" is true and useless. Every caller that sees it has
 * the same question — is this a throttle that clears on its own, or a network
 * problem that does not — and both arrive as the same 503. The per-venue detail
 * is what answers it, and it only counts if it is machine-readable: a sentence
 * naming each venue's English explanation is something to read in a log at 3am
 * and something a program cannot act on.
 */

const SYMBOL = 'BTCUSDT';

function candles(count = 3): Candle[] {
    return Array.from({ length: count }, (_, index) => ({
        timestamp: 1_700_000_000_000 + index * 3_600_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100 + index,
        volume: 1,
    }));
}

function venue(
    name: string,
    behaviour: {
        getPrice?: () => Promise<AssetPrice>;
        getCandles?: () => Promise<Candle[]>;
        getAttributedCandles?: () => Promise<ProviderCandles>;
    },
): MarketDataProvider {
    const price = behaviour.getPrice ?? (async () => ({ symbol: SYMBOL, price: 100 }));
    const series = behaviour.getCandles ?? (async () => candles());
    const attributed =
        behaviour.getAttributedCandles ??
        (async (): Promise<ProviderCandles> => ({
            venue: name,
            symbol: SYMBOL,
            candles: await series(),
        }));

    return {
        name,
        symbol: SYMBOL,
        getPrice: vi.fn(price),
        getCandles: vi.fn(series),
        getHistoricalCandles: vi.fn(series),
        getAttributedCandles: vi.fn(attributed),
    };
}

function chain(...providers: MarketDataProvider[]): FailoverProvider {
    const [primary, ...backups] = providers;

    if (primary === undefined) {
        throw new Error('a chain needs a primary');
    }

    return new FailoverProvider(
        { name: primary.name, provider: primary },
        backups.map((provider) => ({ name: provider.name, provider })),
    );
}

function failWith(
    kind: ProviderError['kind'],
    overrides: { httpStatus?: number } = {},
) {
    return async (): Promise<never> => {
        throw new ProviderError(kind, `venue said ${kind}`, {
            context: {
                provider: 'unused',
                ...(overrides.httpStatus === undefined
                    ? {}
                    : { httpStatus: overrides.httpStatus }),
            },
        });
    };
}

async function rejection(
    provider: FailoverProvider,
): Promise<ProviderError> {
    const error = await provider.getPrice().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);

    return error as ProviderError;
}

describe('failover error semantics', () => {
    it('carries what each venue said, machine-readably', async () => {
        const error = await rejection(
            chain(
                venue('binance', { getPrice: failWith('rate_limited', { httpStatus: 429 }) }),
                venue('bitget', { getPrice: failWith('timeout') }),
            ),
        );

        const attempted = error.details['attempted'] as Array<{
            venue: string;
            kind: string | null;
            code: string | null;
            httpStatus: number | null;
        }>;

        // A log line would read "binance 429, bitget timeout" and a program
        // would read nothing at all. This is the part a program reads.
        expect(attempted).toHaveLength(2);
        expect(attempted[0]).toMatchObject({
            venue: 'binance',
            kind: 'rate_limited',
            httpStatus: 429,
        });
        expect(attempted[1]).toMatchObject({
            venue: 'bitget',
            kind: 'timeout',
        });
    });

    it('names a chain-wide throttle as a throttle', async () => {
        // Both venues throttled points at our own request rate, not at the
        // network. Reporting an outage would send an operator to the wrong place.
        const error = await rejection(
            chain(
                venue('binance', { getPrice: failWith('rate_limited', { httpStatus: 429 }) }),
                venue('bitget', { getPrice: failWith('rate_limited', { httpStatus: 429 }) }),
            ),
        );

        expect(error.kind).toBe('rate_limited');
        expect(error.statusCode).toBe(503);
        expect(error.code).toBe('MARKET_RATE_LIMITED');
    });

    it('keeps a timeout a timeout only while every venue agrees', async () => {
        const allTimedOut = await rejection(
            chain(
                venue('binance', { getPrice: failWith('timeout') }),
                venue('bitget', { getPrice: failWith('timeout') }),
            ),
        );

        expect(allTimedOut.kind).toBe('timeout');
        expect(allTimedOut.statusCode).toBe(504);

        // One venue timing out and the other refusing is not a gateway timeout.
        // There is nothing to wait for, and telling a client to come back in a
        // second while the backup is still refusing is how a throttle is earned.
        const mixed = await rejection(
            chain(
                venue('binance', { getPrice: failWith('timeout') }),
                venue('bitget', { getPrice: failWith('unavailable') }),
            ),
        );

        expect(mixed.kind).toBe('unavailable');
        expect(mixed.statusCode).toBe(502);
    });

    it('does not invent a reason for a failure it cannot classify', async () => {
        const error = await rejection(
            chain(
                venue('binance', {
                    getPrice: async () => {
                        throw new Error('something nobody expected');
                    },
                }),
                venue('bitget', { getPrice: failWith('unavailable') }),
            ),
        );

        // Null rather than a guess. Guessing "timeout" would send it down the
        // retry path forever and hide a bug behind a plausible-looking number.
        const attempted = error.details['attempted'] as Array<{
            venue: string;
            kind: string | null;
            code: string | null;
            httpStatus: number | null;
        }>;

        expect(attempted[0]?.kind).toBeNull();
        expect(attempted[0]?.code).toBeNull();
        expect(error.kind).toBe('unavailable');
    });

    it('still serves the last good venue it can reach', async () => {
        // The point of the chain, and the reason a typed aggregate is safe to
        // add: a failure that is described rather than swallowed.
        const error = await rejection(
            chain(
                venue('binance', { getPrice: failWith('rate_limited', { httpStatus: 429 }) }),
                venue('bitget', { getPrice: failWith('timeout') }),
            ),
        );

        expect(error.code).toBe('MARKET_RATE_LIMITED');
        expect(error.provider).toBe('failover');
    });
});
