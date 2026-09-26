import { describe, expect, it } from 'vitest';

import { FailoverProvider } from './failover.provider.js';
import { MarketDataError } from '../errors/market-data.error.js';

import type { MarketDataProvider } from './providers/market-data.provider.js';

const PRICE = { symbol: 'BTCUSDT', price: 84_000 };

/** Plain counters rather than mock handles: the provider is typed as an
 * interface, so the spy methods behind it are not reachable from here. */
function venue(
    name: string,
    behaviour: {
        price?: () => Promise<typeof PRICE>;
        candles?: (limit?: number) => Promise<never[]>;
        historical?: (limit: number) => Promise<never[]>;
    } = {},
) {
    const calls = { price: 0, candles: 0, historical: 0 };

    const provider: MarketDataProvider = {
        getPrice: async () => {
            calls.price += 1;

            return behaviour.price ? behaviour.price() : PRICE;
        },
        getCandles: async () => {
            calls.candles += 1;

            return behaviour.candles ? behaviour.candles() : [];
        },
        getHistoricalCandles: async (limit: number) => {
            calls.historical += 1;

            return behaviour.historical ? behaviour.historical(limit) : [];
        },
    };

    return { name, provider, calls };
}

const broken = (name: string, message: string) =>
    venue(name, {
        price: async () => {
            throw new MarketDataError(message);
        },
        candles: async () => {
            throw new MarketDataError(message);
        },
        historical: async () => {
            throw new MarketDataError(message);
        },
    });

describe('failing over between venues', () => {
    it('uses the primary while it answers', async () => {
        const first = venue('binance', {});
        const second = venue('bitget', {});

        const provider = new FailoverProvider(first, [second]);

        await provider.getPrice();

        expect(first.calls.price).toBe(1);
        expect(second.calls.price).toBe(0);
    });

    it('moves to the backup within the same request, not after the retries', async () => {
        // A backup consulted only once the primary has finished timing out and
        // retrying is not a backup: the visitor has already waited for all of it.
        const first = broken('binance', 'connect ETIMEDOUT');
        const second = venue('bitget', {});

        const provider = new FailoverProvider(first, [second]);

        await expect(provider.getPrice()).resolves.toEqual(PRICE);
        expect(provider.activeVenue).toBe('bitget');
    });

    it('does not let a switching backup hide a primary that is fine', async () => {
        // Reported as a symptom during a real outage: a dashboard that showed
        // Bitget's price while Binance was healthy, purely because the first
        // request of the process happened to land during a blip.
        const switches: string[] = [];
        const first = venue('binance', {});
        const second = venue('bitget', {});

        const provider = new FailoverProvider(first, [second], {
            onSwitch: (to) => switches.push(to),
        });

        await provider.getPrice();
        await provider.getPrice();
        await provider.getPrice();

        expect(switches).toEqual([]);
        expect(provider.activeVenue).toBe('binance');
    });

    it('stays on the backup instead of retrying a dead primary every minute', async () => {
        // The poller runs once a minute. Without this, every request would pay a
        // full timeout for a venue that is refusing connections.
        const first = broken('binance', 'connect ETIMEDOUT');
        const second = venue('bitget', {});

        const provider = new FailoverProvider(first, [second]);

        await provider.getPrice();
        const afterFirst = first.calls.price;

        await provider.getPrice();
        await provider.getPrice();

        expect(first.calls.price).toBe(afterFirst);
        expect(second.calls.price).toBe(3);
    });

    it('gives the primary several chances before moving the site back', async () => {
        // A venue that answers once and then fails again would otherwise put a
        // full timeout in front of every request for the length of the outage.
        const switches: string[] = [];
        let primaryUp = false;
        let backupUp = true;

        const primary = venue('binance', {
            price: async () => {
                if (!primaryUp) {
                    throw new MarketDataError('still down');
                }

                return PRICE;
            },
        });
        const backup = venue('bitget', {
            price: async () => {
                if (!backupUp) {
                    throw new MarketDataError('HTTP 500');
                }

                return PRICE;
            },
        });

        const provider = new FailoverProvider(primary, [backup], {
            recoverySuccesses: 3,
            onSwitch: (to) => switches.push(to),
        });

        await provider.getPrice();
        expect(provider.activeVenue).toBe('bitget');

        // The primary is not probed while the backup is healthy: for a venue
        // blocked by region it may never return, and every probe is a timeout.
        primaryUp = true;
        await provider.getPrice();
        expect(provider.activeVenue).toBe('bitget');
        expect(primary.calls.price).toBe(1);

        // The backup fails, the primary answers, and one answer is not enough to
        // move the whole site: a venue that fails on every other call would put
        // a timeout in front of every request again.
        backupUp = false;

        for (let answer = 1; answer <= 2; answer += 1) {
            await provider.getPrice();
            expect(provider.activeVenue).toBe('bitget');
        }

        // The third consecutive answer moves the site back for good.
        await provider.getPrice();
        expect(provider.activeVenue).toBe('binance');
        expect(switches).toEqual(['bitget', 'binance']);
    });

    it('carries every venue, not just the two first tried', async () => {
        const first = broken('binance', 'unreachable');
        const second = broken('bitget', 'HTTP 500');
        const third = venue('other', {});

        const provider = new FailoverProvider(first, [second, third]);

        await expect(provider.getPrice()).resolves.toEqual(PRICE);
        expect(provider.activeVenue).toBe('other');
    });

    it('names every venue it tried when all of them fail', async () => {
        // A single "no data" message would leave an operator with nowhere to
        // start, and this is precisely the situation the backup exists for.
        const provider = new FailoverProvider(
            broken('binance', 'unreachable from this region'),
            [broken('bitget', 'HTTP 500')],
        );

        const error = await provider.getPrice().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(MarketDataError);
        expect((error as MarketDataError).code).toBe('MARKET_DATA_UNAVAILABLE');
        const cause = (error as MarketDataError).cause as {
            attempted: Array<{ venue: string; reason: string }>;
        };
        expect(cause.attempted.map((entry) => entry.venue)).toEqual(['binance', 'bitget']);
        expect(cause.attempted[0]?.reason).toMatch(/unreachable from this region/);
    });

    it('fails over for candles and history too, not only for the price', async () => {
    const behaviour = {
        candles: (limit?: number) => Promise.resolve([] as never[]),
        historical: (limit: number) => {
            expect(limit).toBe(2000);

            return Promise.resolve([] as never[]);
        },
    };
    const second = venue('bitget', behaviour);

    const provider = new FailoverProvider(broken('binance', 'down'), [second]);

    await provider.getCandles(10);
    await provider.getHistoricalCandles(2000);

    expect(second.calls.candles).toBe(1);
    expect(second.calls.historical).toBe(1);
});
});
