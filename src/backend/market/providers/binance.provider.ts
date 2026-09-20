import { z } from 'zod';

import type {
    BitcoinPrice,
    Candle,
} from '../../types/market';

import { MarketDataError } from '../../errors/market-data.error';

import type { MarketDataProvider } from './market-data.provider';

const BinanceNumberSchema = z
    .union([
        z.string(),
        z.number(),
    ])
    .transform((value) => Number(value))
    .refine(Number.isFinite, {
        message: 'Value must be a finite number',
    });

const BinancePriceSchema = z.object({
    symbol: z.string(),
    price: BinanceNumberSchema,
});

const BinanceCandleSchema = z.array(
    z.tuple([
        BinanceNumberSchema,
        BinanceNumberSchema,
        BinanceNumberSchema,
        BinanceNumberSchema,
        BinanceNumberSchema,
        BinanceNumberSchema,
    ]),
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
            price: validatedData.price,
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
            timestamp: candle[0],
            open: candle[1],
            high: candle[2],
            low: candle[3],
            close: candle[4],
            volume: candle[5],
        }));
    }
}
