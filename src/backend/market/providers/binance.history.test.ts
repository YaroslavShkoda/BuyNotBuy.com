import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BinanceProvider } from './binance.provider.js';
import { MAX_CANDLE_LIMIT } from '../../config/market.config.js';

import type { Candle } from '../../types/market.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 1_700_000_000_000;
const INTERVAL_MS = 3_600_000;
const ENDPOINT = 'https://data-api.binance.vision/api/v3/klines';

const originalFetch = globalThis.fetch;

function klineRow(timestamp: number, close: number) {
    return [
        timestamp,
        String(close - 1),
        String(close + 1),
        String(Math.max(1, close - 2)),
        String(close),
        '1000',
        timestamp + INTERVAL_MS - 1,
        '0',
        0,
        '0',
        '0',
        '0',
    ];
}

/**
 * Serves a real, ordered, paged series the way Binance does: ascending by
 * time, `endTime` honoured, and one bar past the end that is still forming so
 * the provider layer has something to drop.
 */
function serveHistory(total: number) {
    const calls: string[] = [];

    const closed = Array.from(
        { length: Math.floor((NOW - ORIGIN) / INTERVAL_MS) },
        (_, index) => ORIGIN + index * INTERVAL_MS,
    ).slice(-total);

    // The bar currently in progress: it closes after "now" and must not reach
    // the indicators.
    const forming = ORIGIN + (closed.length + (ORIGIN + closed.length * INTERVAL_MS <= NOW ? 1 : 0)) * INTERVAL_MS;
    const series = [...closed, forming];

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));

        // The endpoint is asserted rather than assumed: a provider pointed at
        // the wrong host would still return a well-formed response in a test
        // that only parsed the body.
        expect(url.origin + url.pathname).toBe(ENDPOINT);

        calls.push(url.toString());

        const limit = Number(url.searchParams.get('limit'));
        const endTime = url.searchParams.get('endTime');

        const eligible =
            endTime === null
                ? series
                : series.filter((timestamp) => timestamp <= Number(endTime));

        const selected = eligible.slice(-limit);

        return new Response(
            JSON.stringify(selected.map((t) => klineRow(t, 100_000 + (t % 1000)))),
            {
                status: 200,
                headers: { 'content-type': 'application/json' },
            },
        );
    }) as typeof fetch;

    return calls;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

describe('BinanceProvider.getHistoricalCandles', () => {
    it('serves a single request when the limit fits in one page', async () => {
        const calls = serveHistory(5_000);

        const candles = await new BinanceProvider().getHistoricalCandles(500);

        expect(calls).toHaveLength(1);
        expect(candles).toHaveLength(500);
    });

    it('pages backwards when the limit exceeds one response', async () => {
        const calls = serveHistory(5_000);

        const candles = await new BinanceProvider().getHistoricalCandles(2_500);

        // Binance caps a request at 1000 and says nothing when it clamps, so a
        // backtest without paging would have no data left to evaluate.
        expect(calls.length).toBeGreaterThan(1);
        expect(candles).toHaveLength(2_500);
    });

    it('never asks for more than the provider allows in one response', async () => {
        const calls = serveHistory(5_000);

        await new BinanceProvider().getHistoricalCandles(2_500);

        for (const call of calls) {
            const limit = Number(new URL(call).searchParams.get('limit'));

            expect(limit).toBeLessThanOrEqual(MAX_CANDLE_LIMIT);
        }
    });

    it('asks each page for strictly older bars', async () => {
        const calls = serveHistory(5_000);

        await new BinanceProvider().getHistoricalCandles(2_500);

        const endTimes = calls
            .map((call) => new URL(call).searchParams.get('endTime'))
            .filter((value): value is string => value !== null)
            .map(Number);

        // The first page needs no endTime; every later one must reach further
        // back, or the loop would keep re-reading the same bars.
        expect(calls[0]).not.toContain('endTime');
        expect(endTimes.length).toBeGreaterThan(0);

        for (let index = 1; index < endTimes.length; index += 1) {
            expect(endTimes[index]!).toBeLessThan(endTimes[index - 1]!);
        }
    });

    it('returns the bars in ascending order', async () => {
        serveHistory(5_000);

        const candles = await new BinanceProvider().getHistoricalCandles(2_500);

        for (let index = 1; index < candles.length; index += 1) {
            expect(candles[index]!.timestamp).toBeGreaterThan(
                candles[index - 1]!.timestamp,
            );
        }
    });

    it('returns no duplicates across page boundaries', async () => {
        serveHistory(5_000);

        const candles = await new BinanceProvider().getHistoricalCandles(2_500);

        const timestamps = candles.map((candle: Candle) => candle.timestamp);

        expect(new Set(timestamps).size).toBe(timestamps.length);
    });

    it('keeps the most recent bars when the sample is trimmed to size', async () => {
        serveHistory(5_000);

        const full = await new BinanceProvider().getHistoricalCandles(1_000);
        const trimmed = await new BinanceProvider().getHistoricalCandles(300);

        // Taking the head of a descending fetch would keep the ancient bars
        // and throw away the present.
        expect(trimmed.at(-1)?.timestamp).toBe(full.at(-1)?.timestamp);
    });

    it('stops instead of looping when the provider ignores endTime', async () => {
        globalThis.fetch = vi.fn(async () => {
            const rows = Array.from({ length: 10 }, (_, index) =>
                klineRow(NOW - (index + 1) * INTERVAL_MS, 100_000),
            );

            return new Response(JSON.stringify(rows), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        const provider = new BinanceProvider();
        const candles = await provider.getHistoricalCandles(5_000);

        // The same page comes back every time, so the series stops growing.
        expect(candles).toHaveLength(10);
        expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(2);
    });

    it('stops when history runs out', async () => {
        globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
            const hasEndTime = String(input).includes('endTime');

            return new Response(
                JSON.stringify(hasEndTime ? [] : [klineRow(ORIGIN, 100_000)]),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                },
            );
        }) as typeof fetch;

        const candles = await new BinanceProvider().getHistoricalCandles(5_000);

        expect(candles).toHaveLength(1);
    });

    it('never returns the still-forming bar', async () => {
        serveHistory(5_000);

        const candles = await new BinanceProvider().getHistoricalCandles(500);

        for (const candle of candles) {
            expect(candle.timestamp).toBeLessThanOrEqual(NOW - INTERVAL_MS);
        }
    });
});
