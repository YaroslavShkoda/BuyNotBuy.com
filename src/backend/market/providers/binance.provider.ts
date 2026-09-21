import { z } from 'zod';

import type {
    AssetPrice,
    Candle,
} from '../../types/market';

import { MarketDataError } from '../../errors/market-data.error';

import { marketConfig } from '../../config/market.config';

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

export class BinanceProvider implements MarketDataProvider {
    async getPrice(): Promise<AssetPrice> {
        const url =
            `${marketConfig.baseUrl}` +
            '/api/v3/ticker/price' +
            `?symbol=${marketConfig.symbol}`;

        try {
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
        } catch (error) {
            if (error instanceof MarketDataError) {
                throw error;
            }

            throw new MarketDataError(
                'Failed to fetch market price from Binance',
            );
        }
    }

    async getCandles(
        limit: number = marketConfig.defaultCandleLimit,
    ): Promise<Candle[]> {
        const url =
            `${marketConfig.baseUrl}/api/v3/klines` +
            `?symbol=${marketConfig.symbol}` +
            `&interval=${marketConfig.candleInterval}` +
            `&limit=${limit}`;

        try {
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
        } catch (error) {
            if (error instanceof MarketDataError) {
                throw error;
            }

            throw new MarketDataError(
                'Failed to fetch market candles from Binance',
            );
        }
    }
}


