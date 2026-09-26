import { z } from 'zod';

import type {
    AssetPrice,
    Candle,
} from '../../types/market.js';

import { MarketDataError } from '../../errors/market-data.error.js';

import { marketConfig } from '../../config/market.config.js';
import { MAX_CANDLE_LIMIT } from '../../config/market.config.js';
import { sendBinanceRequest } from './binance-http.js';

import type { MarketDataProvider } from './market-data.provider.js';

const PRICE_ENDPOINT = '/api/v3/ticker/price';
const KLINES_ENDPOINT = '/api/v3/klines';

/**
 * Binance sends every numeric field as a string.
 *
 * `Number('')` is 0, so an empty field would otherwise be accepted as a
 * genuine zero — for a price that means a chart that looks plausible and is
 * wrong. An empty field is therefore taken as zero only where that is the
 * documented meaning (the placeholder fields Binance leaves blank), and every
 * other value has to parse. `MARKET_` prefixed numbers never appear here, so
 * the whole string is used rather than a lenient partial parse.
 */
const BinanceNumberSchema = z
    .union([
        z.string(),
        z.number(),
    ])
    .transform((value) => {
        if (typeof value === 'number') {
            return value;
        }

        const trimmed = value.trim();

        return trimmed === '' ? 0 : Number(trimmed);
    })
    .refine(Number.isFinite, {
        message: 'Value must be a finite number',
    });

/** Prices and volumes cannot be negative; a negative one is corrupt data. */
const BinanceNonNegativeSchema = BinanceNumberSchema.refine(
    (value) => value >= 0,
    {
        message: 'Value must not be negative',
    },
);

const BinancePriceSchema = z.object({
    symbol: z.string(),
    price: BinanceNonNegativeSchema,
});

/**
 * Bounded on purpose: a response larger than the provider could ever produce
 * is malformed, and materialising it first would let a bad upstream exhaust
 * memory before anything could notice.
 */
const BinanceCandleSchema = z.array(
    z.tuple(
        [
            BinanceNonNegativeSchema,
            BinanceNonNegativeSchema,
            BinanceNonNegativeSchema,
            BinanceNonNegativeSchema,
            BinanceNonNegativeSchema,
            BinanceNonNegativeSchema,
            BinanceNonNegativeSchema,
        ],
        z.unknown(),
    ),
).max(MAX_CANDLE_LIMIT);

export class BinanceProvider implements MarketDataProvider {
    async getPrice(): Promise<AssetPrice> {        const url =
            `${marketConfig.baseUrl}` +
            PRICE_ENDPOINT +
            `?symbol=${encodeURIComponent(marketConfig.symbol)}`;

        try {
            const response = await sendBinanceRequest({
                url,
                endpoint: PRICE_ENDPOINT,
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
                            endpoint: PRICE_ENDPOINT,
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
                PRICE_ENDPOINT,
                'Failed to fetch market price from Binance',
            );
        }
    }

    async getCandles(
        limit: number = marketConfig.defaultCandleLimit,
    ): Promise<Candle[]> {
        return this.fetchKlines(limit);
    }

    /**
     * Pages backwards through history, newest page first.
     *
     * Binance caps a single klines request at 1000 candles and says nothing
     * when it clamps: asking for 3000 returns 1000, which is indistinguishable
     * from a market that only has 1000 bars. Without paging, a backtest would
     * consume its whole sample on the indicator warm-up and have nothing left
     * to evaluate.
     */
    async getHistoricalCandles(limit: number): Promise<Candle[]> {
        if (limit <= MAX_CANDLE_LIMIT) {
            return this.fetchKlines(limit);
        }

        const pageSize = MAX_CANDLE_LIMIT;
        const collected: Candle[] = [];

        let oldestSeen = Number.POSITIVE_INFINITY;

        while (collected.length < limit) {
            const page = await this.fetchKlines(
                pageSize,
                oldestSeen === Number.POSITIVE_INFINITY ? undefined : oldestSeen - 1,
            );

            if (page.length === 0) {
                break;
            }

            const oldest = page[0]?.timestamp;

            if (oldest === undefined || oldest >= oldestSeen) {
                // The provider ignored endTime and is handing back the same
                // page; continuing would spin forever.
                break;
            }

            collected.push(...page);
            oldestSeen = oldest;
        }

        // Pages arrive newest first and are concatenated in that order, so the
        // most recent bars are at the end once sorted. Taking the head would
        // throw away the present and keep the ancient history instead.
        return collected
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(-limit);
    }

    private async fetchKlines(
        limit: number,
        endTime?: number,
    ): Promise<Candle[]> {
        const url =
            `${marketConfig.baseUrl}${KLINES_ENDPOINT}` +
            `?symbol=${encodeURIComponent(marketConfig.symbol)}` +
            `&interval=${encodeURIComponent(marketConfig.candleInterval)}` +
            `&limit=${limit}` +
            (endTime === undefined ? '' : `&endTime=${endTime}`);

        try {
            const response = await sendBinanceRequest({
                url,
                endpoint: KLINES_ENDPOINT,
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
                            endpoint: KLINES_ENDPOINT,
                            httpStatus: response.status,
                        },
                    },
                );
            }

            const data = await response.json();

            const validatedData = BinanceCandleSchema.parse(data);

            return dropStillFormingCandles(validatedData, Date.now());
        } catch (error) {
            throw normalizeBinanceError(
                error,
                KLINES_ENDPOINT,
                'Failed to fetch market candles from Binance',
            );
        }
    }
}

/**
 * Binance always includes the currently forming candle as the last element of
 * /api/v3/klines. Its close keeps moving, so feeding it into the indicators
 * makes the signal non-reproducible: the same URL returns a different answer
 * every second. Element 6 is the candle's close time in epoch milliseconds.
 */
function dropStillFormingCandles(
    rows: Array<
        [
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            ...unknown[],
        ]
    >,
    now: number,
): Candle[] {
    const candles: Candle[] = [];

    for (const row of rows) {
        const [timestamp, open, high, low, close, volume, closeTime] = row;

        if (closeTime > now) {
            continue;
        }

        candles.push({
            timestamp,
            open,
            high,
            low,
            close,
            volume,
        });
    }

    return candles;
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
