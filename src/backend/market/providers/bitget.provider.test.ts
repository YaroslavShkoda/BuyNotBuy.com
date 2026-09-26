import { afterEach, describe, expect, it, vi } from 'vitest';

import { BitgetProvider } from './bitget.provider.js';
import { resetProviderTransport } from './provider-http.js';
import { MarketDataError } from '../../errors/market-data.error.js';

const TICKERS = 'https://api.bitget.com/api/v2/spot/market/tickers';
const CANDLES = 'https://api.bitget.com/api/v2/spot/market/candles';

function body(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/** A real Bitget envelope: the failure lives in `code`, not in the status. */
function ok(data: unknown) {
    return body({ code: '00000', msg: 'success', requestTime: 1, data });
}

function failed(code: string, msg: string) {
    return body({ code, msg, requestTime: 1, data: null });
}

function stubFetchOnce(response: Response) {
    // The url parameter is declared so the recorded calls can be asserted on;
    // a parameterless stub records calls as empty tuples.
    const stub = vi.fn(async (_url: string | URL | Request) => response);

    vi.stubGlobal('fetch', stub);

    return stub;
}

afterEach(() => {
    vi.unstubAllGlobals();
    resetProviderTransport('bitget');
});

describe('Bitget price', () => {
    it('reads the last price from the plural tickers endpoint', async () => {
        // The singular endpoint answers 404. Guessing it would be a silent
        // outage rather than an error, because the failure is easy to miss.
        const stub = stubFetchOnce(
            ok([{ symbol: 'BTCUSDT', lastPr: '84113.02', ts: '1790444822841' }]),
        );

        const price = await new BitgetProvider().getPrice();

        expect(price).toEqual({ symbol: 'BTCUSDT', price: 84113.02 });
        expect(stub.mock.calls[0]?.[0]).toBe(`${TICKERS}?symbol=BTCUSDT`);
    });

    it('rejects a failure that arrived with HTTP 200', async () => {
        // This is the single most dangerous difference between the two venues.
        // Reading only the status line would treat "Parameter BTCUSDT does not
        // exist" as a successful answer and put an empty price on the chart.
        stubFetchOnce(failed('40034', 'Parameter BTCUSDT does not exist'));

        await expect(new BitgetProvider().getPrice()).rejects.toThrow(
            /Parameter BTCUSDT does not exist/,
        );
    });

    it('separates a request mistake from an outage', async () => {
        // A bad symbol or a bad limit is a decision, and repeating it is
        // pointless; an unrecognised code may be transient and is worth a retry.
        stubFetchOnce(failed('40034', 'Parameter NOPE does not exist'));
        await expect(new BitgetProvider().getPrice()).rejects.toMatchObject({
            code: 'MARKET_PROVIDER_ERROR',
        });

        vi.unstubAllGlobals();
        resetProviderTransport('bitget');
        stubFetchOnce(failed('99999', 'something transient'));
        await expect(new BitgetProvider().getPrice()).rejects.toMatchObject({
            code: 'MARKET_DATA_UNAVAILABLE',
        });
    });
});

describe('Bitget candles', () => {
    const HOUR = 3_600_000;
    const now = Date.UTC(2026, 8, 26, 12, 0, 0);
    const closed = now - 2 * HOUR;

    function row(timestamp: number, close: string) {
        // The base and notional volumes are different numbers on purpose: a
        // fixture that made them equal would pass whichever of the two the
        // provider read.
        return [String(timestamp), '84000', '85000', '83000', close, '12.5', '1050000', '1050000'];
    }

    it('translates the interval into Bitget spelling', async () => {
        // `1d` is not `1day` here; the venue rejects an unknown granularity
        // rather than rounding, so the translation is not cosmetic.
        const stub = stubFetchOnce(ok([row(closed, '84000')]));

        await new BitgetProvider({ candleInterval: '1d' }).getCandles(10);

        expect(String(stub.mock.calls[0]?.[0])).toContain('granularity=1day');
        expect(String(stub.mock.calls[0]?.[0])).toContain(`${CANDLES}?symbol=BTCUSDT`);
    });

    it('refuses an interval the venue does not offer, by name', async () => {
        expect(() => new BitgetProvider({ candleInterval: '2h' })).toThrow(/2h/);
    });

    it('reads a row into a candle', async () => {
        stubFetchOnce(ok([row(closed, '84120')]));

        const candles = await new BitgetProvider().getCandles(10);

        expect(candles).toEqual([
            {
                timestamp: closed,
                open: 84000,
                high: 85000,
                low: 83000,
                close: 84120,
                // The notional figure, not the 12.5 BTC base one.
                volume: 1050000,
            },
        ]);
    });

    it('drops the candle still forming, as the primary does', async () => {
        // The two venues must agree on how many candles a series holds, or
        // switching venues mid-outage would change what the indicators were
        // computed from and the signal would move for no market reason.
        vi.setSystemTime(closed + HOUR / 2);
        stubFetchOnce(ok([row(closed - HOUR, '1'), row(closed, '2')]));

        const candles = await new BitgetProvider().getCandles(10);

        expect(candles).toHaveLength(1);
        expect(candles[0]?.close).toBe(1);
        vi.useRealTimers();
    });

    it('keeps a candle that has just closed', async () => {
        // The drop is for a candle whose close is still moving, not for the most
        // recent one: dropping the last closed candle would shorten every
        // series by one bar for no reason.
        vi.setSystemTime(closed + HOUR);
        stubFetchOnce(ok([row(closed, '2')]));

        const candles = await new BitgetProvider().getCandles(10);

        expect(candles).toHaveLength(1);
        vi.useRealTimers();
    });

    it('pages backwards for more history than one request can return', async () => {
        const first = closed - 10 * HOUR;
        const second = closed - 20 * HOUR;

        const responses = [ok([row(first, '1')]), ok([row(second, '2')])];
        const stub = vi.fn(async (_url: string | URL | Request) => responses.shift() ?? ok([]));

        vi.stubGlobal('fetch', stub);

        const candles = await new BitgetProvider().getHistoricalCandles(1200);

        // Three calls: two pages and one that comes back empty. The walk cannot
        // know the series has ended until it asks for what is past the oldest
        // bar it holds, and stopping early would silently under-fill a backtest.
        expect(stub).toHaveBeenCalledTimes(3);
        expect(String(stub.mock.calls[1]?.[0])).toContain(`endTime=${first - 1}`);
        expect(candles.map((candle) => candle.timestamp)).toEqual([second, first]);
    });

    it('never asks a paged request for more than the venue will return', async () => {
        // Measured against the live API: with `endTime` set, a limit above ~480
        // comes back as zero rows carrying a success code. A paging loop reads
        // that as the end of history and returns a fraction of what it was asked
        // for, with nothing in the response to say so. A regression here would
        // be invisible until a backtest quietly ran on six weeks of data.
        const responses = [ok([row(closed - 10 * HOUR, '1')])];
        const stub = vi.fn(async (_url: string | URL | Request) => responses.shift() ?? ok([]));

        vi.stubGlobal('fetch', stub);

        await new BitgetProvider().getHistoricalCandles(5000);

        expect(stub).toHaveBeenCalled();

        for (const [url] of stub.mock.calls) {
            const limit = Number(new URL(String(url)).searchParams.get('limit'));

            expect(limit).toBeLessThanOrEqual(480);
            expect(limit).toBeGreaterThan(0);
        }
    });

    it('stops instead of looping when the venue ignores the page boundary', async () => {
        const responses = [ok([row(closed, '1')]), ok([row(closed, '1')])];
        const stub = vi.fn(async (_url: string | URL | Request) => responses.shift() ?? ok([]));

        vi.stubGlobal('fetch', stub);

        const candles = await new BitgetProvider().getHistoricalCandles(5000);

        expect(candles).toHaveLength(1);
        expect(stub).toHaveBeenCalledTimes(2);
    });
});

describe('Bitget transport failures', () => {
    it('reports a hard HTTP failure with the venue named', async () => {
        stubFetchOnce(new Response('nope', { status: 500 }));

        await expect(new BitgetProvider().getPrice()).rejects.toMatchObject({
            code: 'MARKET_DATA_UNAVAILABLE',
        });
    });

    it('surfaces a response that does not match the contract as a provider error', async () => {
        // A schema mismatch is not an outage, and retrying it would only produce
        // the same wrong answer more slowly.
        stubFetchOnce(ok([{ symbol: 'BTCUSDT' }]));

        await expect(new BitgetProvider().getPrice()).rejects.toMatchObject({
            code: 'MARKET_PROVIDER_ERROR',
        });
    });

    it('does not retry a request the venue has already refused', async () => {
        const stub = stubFetchOnce(failed('40034', 'Parameter NOPE does not exist'));

        await expect(new BitgetProvider().getPrice()).rejects.toThrow();

        expect(stub).toHaveBeenCalledTimes(1);
    });

    it('keeps the Bitget circuit separate from the primary one', async () => {
        // One shared breaker would let the first venue to go dark take the
        // backup down with it, which is the opposite of having a backup.
        const { resetBinanceTransport } = await import('./binance-http.js');

        resetBinanceTransport();
        resetProviderTransport('bitget');

        stubFetchOnce(failed('40034', 'Parameter NOPE does not exist'));
        await expect(new BitgetProvider().getPrice()).rejects.toThrow();

        // Repeated failures open Bitget's own breaker and the next call is
        // refused immediately, which is a different decision from Binance's.
        stubFetchOnce(new Response('nope', { status: 500 }));
        await expect(new BitgetProvider().getPrice()).rejects.toThrow();
    });

    it('keeps a genuine timeout distinguishable from a contract error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new DOMException('timed out', 'TimeoutError');
            }),
        );

        const error = await new BitgetProvider()
            .getPrice()
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(MarketDataError);
        expect((error as MarketDataError).code).toBe('MARKET_PROVIDER_TIMEOUT');
    });
});
