import { z } from 'zod';

import type {
    BitcoinPrice,
    Candle,
} from '../../types/market';

import { MarketDataError } from '../../errors/market-data.error';

import type { MarketDataProvider } from './market-data.provider';

const BinancePriceSchema = z.object({
    symbol: z.string(),
    price: z.string(),
});

const BinanceCandleSchema = z.array(
    z.array(z.string().or(z.number())),
);

const BINANCE_BASE_URL = 'https://data-api.binance.vision';

const BTC_SYMBOL = 'BTCUSDT';
const CANDLE_INTERVAL = '1h';

export class BinanceProvider implements MarketDataProvider {
    async getBitcoinPrice(): Promise<BitcoinPrice> {
        const url =
            `${BINANCE_BASE_URL}` +
            '/api/v3/ticker/price' +
            `?symbol=${BTC_SYMBOL}`;

        const response = await fetch(url);

        if (!response.ok) {
            throw new MarketDataError(
                `Binance API error: ${response.status}`,
            );
        }

        const data = await response.json();

        const validatedData = BinancePriceSchema.parse(data);

        return {
            symbol: validatedData.symbol,
            price: Number(validatedData.price),
        };
    }

    async getBitcoinCandles(
        limit = 300,
    ): Promise<Candle[]> {
        const url =
            `${BINANCE_BASE_URL}/api/v3/klines` +
            `?symbol=${BTC_SYMBOL}` +
            `&interval=${CANDLE_INTERVAL}` +
            `&limit=${limit}`;

        const response = await fetch(url);

        if (!response.ok) {
            throw new MarketDataError(
                `Binance API error: ${response.status}`,
            );
        }

        const data = await response.json();

        const validatedData = BinanceCandleSchema.parse(data);

        return validatedData.map((candle) => ({
            timestamp: Number(candle[0]),
            open: Number(candle[1]),
            high: Number(candle[2]),
            low: Number(candle[3]),
            close: Number(candle[4]),
            volume: Number(candle[5]),
        }));
    }
}
