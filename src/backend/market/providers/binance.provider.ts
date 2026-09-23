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
            const response = await fetch(url, {
                signal: AbortSignal.timeout(
                    marketConfig.requestTimeoutMs,
                ),
            });

            if (!response.ok) {
                throw new MarketDataError(
                    `Binance price request failed with HTTP ${response.status}`,
                    {
                        code: response.status === 429 || response.status >= 500
                            ? 'MARKET_DATA_UNAVAILABLE'
                            : 'MARKET_PROVIDER_ERROR',
                        statusCode: response.status === 429 || response.status >= 500
                            ? 503
                            : 502,
                        cause: {
                            provider: 'binance',
                            endpoint: '/api/v3/ticker/price',
                            httpStatus: response.status,
                        },
                    },
                );
            }

            const data = await response.json();

            const validatedData = BinancePriceSchema.parse(data);

            return {
                symbol: validatedData.symbol,
                price: validatedData.price,
            };
        } catch (error) {
            throw normalizeBinanceError(
                error,
                '/api/v3/ticker/price',
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
            const response = await fetch(url, {
                signal: AbortSignal.timeout(
                    marketConfig.requestTimeoutMs,
                ),
            });

            if (!response.ok) {
                throw new MarketDataError(
                    `Binance klines request failed with HTTP ${response.status}`,
                    {
                        code: response.status === 429 || response.status >= 500
                            ? 'MARKET_DATA_UNAVAILABLE'
                            : 'MARKET_PROVIDER_ERROR',
                        statusCode: response.status === 429 || response.status >= 500
                            ? 503
                            : 502,
                        cause: {
                            provider: 'binance',
                            endpoint: '/api/v3/klines',
                            httpStatus: response.status,
                        },
                    },
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
            throw normalizeBinanceError(
                error,
                '/api/v3/klines',
                'Failed to fetch market candles from Binance',
            );
        }
    }
}

function normalizeBinanceError(
    error: unknown,
    endpoint: string,
    fallbackMessage: string,
): MarketDataError {
    if (error instanceof MarketDataError) {
        return error;
    }

    if (isTimeoutError(error)) {
        return new MarketDataError(
            'Market data provider timed out',
            {
                code: 'MARKET_PROVIDER_TIMEOUT',
                cause: {
                    provider: 'binance',
                    endpoint,
                    timeoutMs: marketConfig.requestTimeoutMs,
                    originalError: toLogSafeCause(error),
                },
            },
        );
    }

    if (error instanceof z.ZodError) {
        return new MarketDataError(
            'Market data provider returned an unexpected response',
            {
                code: 'MARKET_PROVIDER_ERROR',
                cause: {
                    provider: 'binance',
                    endpoint,
                    originalError: toLogSafeCause(error),
                },
            },
        );
    }

    return new MarketDataError(
        fallbackMessage,
        {
            code: 'MARKET_DATA_UNAVAILABLE',
            cause: {
                provider: 'binance',
                endpoint,
                originalError: toLogSafeCause(error),
            },
        },
    );
}

function isTimeoutError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'TimeoutError';
}

function toLogSafeCause(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }

    return typeof error;
}
