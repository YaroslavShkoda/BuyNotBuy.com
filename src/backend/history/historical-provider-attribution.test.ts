import { afterEach, describe, expect, it, vi } from 'vitest';
import { BinanceProvider } from '../market/providers/binance.provider.js';
import { BitgetProvider } from '../market/providers/bitget.provider.js';
import { MockProvider } from '../market/providers/mock.provider.js';
import { resetProviderTransport } from '../market/providers/provider-http.js';

afterEach(() => {
    vi.unstubAllGlobals();
    resetProviderTransport('binance');
    resetProviderTransport('bitget');
});
describe('built-in historical request attribution', () => {
    it.each(['binance', 'bitget'] as const)('keeps %s historical request market and interval in the response', async (venue) => {
        const timestamp = 1_699_999_200_000;
        const row = [String(timestamp), '100', '101', '99', '100', '10', '1000'];
        const payload = venue === 'binance'
            ? [[timestamp, '100', '101', '99', '100', '10', timestamp + 899_999, '1000', 1, '5', '500', '0']]
            : { code: '00000', msg: 'success', requestTime: 1, data: [row] };
        const fetch = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetch);
        const provider = venue === 'binance' ? new BinanceProvider('ETHUSDT', '15m')
            : new BitgetProvider({ symbol: 'ETHUSDT', candleInterval: '15m' });
        const result = await provider.getAttributedHistoricalCandles(1, timestamp + 900_000);
        expect(result).toMatchObject({ venue, symbol: 'ETHUSDT', interval: '15m', candles: [{ timestamp, close: 100 }] });
        const url = String(fetch.mock.calls[0]?.[0]);
        expect(url).toContain('symbol=ETHUSDT');
        expect(url).toContain(venue === 'binance' ? 'interval=15m' : 'granularity=15min');
    });
    it('attributes mock historical bars to its constructed series', async () => {
        const result = await new MockProvider('ETHUSDT', '15m').getAttributedHistoricalCandles(3);
        expect(result).toMatchObject({ venue: 'mock', symbol: 'ETHUSDT', interval: '15m' });
        expect(result.candles).toHaveLength(2);
        expect((result.candles[1]?.timestamp ?? 0) - (result.candles[0]?.timestamp ?? 0)).toBe(900_000);
    });
});
