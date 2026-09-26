import { afterEach, describe, expect, it, vi } from 'vitest';

import { NetworkAccessError } from './no-network.js';

/**
 * These tests are the guard's own proof of life.
 *
 * A guard that has never fired is indistinguishable from a guard that is
 * broken, and a broken guard looks exactly like a working one right up until
 * the day a test quietly starts depending on a real exchange. So each seam is
 * exercised on purpose here, and the refusal is asserted by name: a test that
 * trips the guard should say so rather than time out.
 */

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the network guard', () => {
    it('refuses fetch', async () => {
        await expect(
            fetch('https://data-api.binance.vision/api/v3/klines'),
        ).rejects.toBeInstanceOf(NetworkAccessError);
    });

    it('names the target it refused', async () => {
        await expect(fetch('https://example.com/trade')).rejects.toThrow(
            /example\.com\/trade/,
        );
    });

    it('refuses a URL object as well as a string', async () => {
        await expect(fetch(new URL('https://example.com/ping'))).rejects.toThrow(
            /example\.com\/ping/,
        );
    });

    it('refuses a Request', async () => {
        await expect(
            fetch(new Request('https://example.com/orders')),
        ).rejects.toThrow(/example\.com\/orders/);
    });

    it('refuses the Binance transport, which is the only outbound path here', async () => {
        const { sendBinanceRequest, resetBinanceTransport } = await import(
            '../market/providers/binance-http.js'
        );

        resetBinanceTransport();

        // This is the assertion that matters. The provider module is
        // untouched by the guard, and it is where a real exchange call would
        // actually be made.
        await expect(
            sendBinanceRequest({
                url: 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=10',
                endpoint: '/api/v3/klines',
            }),
        ).rejects.toThrow(/data-api\.binance\.vision/);
    });

    it('explains how to make the test pass', async () => {
        // The message is the only thing a developer sees at the moment the
        // guard fires, and it has to say what to do next.
        await expect(fetch('https://example.com')).rejects.toThrow(
            /Replace it with a fixture or a stub/,
        );
    });

    it('is reinstalled for every test, not just the first', async () => {
        // A suite that assigns its own stub in one test would otherwise leave
        // the next test with a stub pointing at fixtures it does not own.
        const stub = vi.fn(async () => new Response('ok'));

        vi.stubGlobal('fetch', stub);

        expect(globalThis.fetch).toBe(stub);

        vi.unstubAllGlobals();

        await expect(fetch('https://example.com')).rejects.toBeInstanceOf(
            NetworkAccessError,
        );
    });
});

describe('what the guard does not block', () => {
    it('leaves the local database reachable', async () => {
        // The guard exists for the network. PostgreSQL is a local dependency
        // the repositories cannot be tested without, and the only address the
        // guard waves through is the one in DATABASE_URL.
        const { query } = await import('../db/pool.js');

        const result = await query<{ one: number }>('SELECT 1 AS one');

        expect(result.rows[0]?.one).toBe(1);
    });

    it('still refuses a TCP connection to anywhere else', async () => {
        const { isDatabaseAddress } = await import('./no-network.js');

        // Tested as a decision rather than through `net.connect`, on purpose:
        // a named ESM import of `connect` is bound when the module is linked,
        // so it keeps the original function and would open a real connection
        // instead of hitting the guard. The rule is what must not widen, and
        // the rule is answerable directly.
        expect(
            isDatabaseAddress([{ host: '203.0.113.1', port: 5432 }]),
        ).toBe(false);
    });

    it('treats the allowance as an address, not as a port number', async () => {
        const { isDatabaseAddress } = await import('./no-network.js');

        // Same port, different host: matching on the port alone would let any
        // other PostgreSQL on the machine be reached from a test.
        expect(
            isDatabaseAddress([{ host: '198.51.100.7', port: 5432 }]),
        ).toBe(false);
    });

    it('allows the address in DATABASE_URL and nothing else on that host', async () => {
        const { isDatabaseAddress } = await import('./no-network.js');

        const allowed = new URL(process.env.DATABASE_URL ?? '');

        expect(
            isDatabaseAddress([
                { host: allowed.hostname, port: Number(allowed.port) },
            ]),
        ).toBe(true);

        // Same host, another port: a stray service on the machine is not the
        // database, and the guard is not a port filter.
        expect(
            isDatabaseAddress([{ host: allowed.hostname, port: 9999 }]),
        ).toBe(false);
    });

    it('allows nothing when DATABASE_URL is absent or unparseable', async () => {
        const { isDatabaseAddress } = await import('./no-network.js');
        const original = process.env.DATABASE_URL;

        try {
            delete process.env.DATABASE_URL;
            expect(isDatabaseAddress([{ host: '127.0.0.1', port: 5432 }])).toBe(false);

            process.env.DATABASE_URL = 'not a url';
            expect(isDatabaseAddress([{ host: '127.0.0.1', port: 5432 }])).toBe(false);
        } finally {
            if (original !== undefined) {
                process.env.DATABASE_URL = original;
            }
        }
    });

    it('leaves fake timers usable', async () => {
        vi.useFakeTimers();

        const started = Date.now();

        vi.advanceTimersByTime(60_000);

        expect(Date.now() - started).toBe(60_000);

        vi.useRealTimers();
    });
});
