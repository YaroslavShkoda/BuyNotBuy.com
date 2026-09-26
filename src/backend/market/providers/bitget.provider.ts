import { z } from 'zod';

import type {
    AssetPrice,
    Candle,
} from '../../types/market.js';

import { MarketDataError } from '../../errors/market-data.error.js';

import { marketConfig } from '../../config/market.config.js';
import { MAX_CANDLE_LIMIT } from '../../config/market.config.js';
import { sendProviderRequest } from './provider-http.js';

import type { MarketDataProvider } from './market-data.provider.js';

const TICKERS_ENDPOINT = '/api/v2/spot/market/tickers';
const CANDLES_ENDPOINT = '/api/v2/spot/market/candles';

/**
 * The backup venue, and the one that answers from inside Russia.
 *
 * Three things about this API differ from the primary's and each one would
 * break silently if copied across:
 *
 * - A failure arrives as HTTP 200 with a non-zero `code` in the body. Reading
 *   only the status would treat "Parameter BTCUSDT does not exist" as a
 *   successful empty answer and put it on the chart.
 * - The ticker endpoint is plural. The singular form answers 404.
 * - Intervals are spelled `1min` and `1day`, not `1m` and `1d`, and an
 *   unrecognised one is rejected outright rather than rounded.
 */

/** Binance-style interval to Bitget granularity, with the candle's own length. */
const GRANULARITIES: Record<string, { granularity: string; durationMs: number }> = {
    '1m': { granularity: '1min', durationMs: 60_000 },
    '3m': { granularity: '3min', durationMs: 180_000 },
    '5m': { granularity: '5min', durationMs: 300_000 },
    '15m': { granularity: '15min', durationMs: 900_000 },
    '30m': { granularity: '30min', durationMs: 1_800_000 },
    '1h': { granularity: '1h', durationMs: 3_600_000 },
    '4h': { granularity: '4h', durationMs: 14_400_000 },
    '6h': { granularity: '6h', durationMs: 21_600_000 },
    '12h': { granularity: '12h', durationMs: 43_200_000 },
    '1d': { granularity: '1day', durationMs: 86_400_000 },
    '3d': { granularity: '3Dutc', durationMs: 259_200_000 },
    '1w': { granularity: '1week', durationMs: 604_800_000 },
};

/** Binance /api/v3/klines silently caps the limit at 1000 per request. */
const SUCCESS_CODE = '00000';

/**
 * The page size used when walking backwards through history.
 *
 * The documented cap is 1000, and that is what a request with no `endTime`
 * will happily return. But once `endTime` is set the endpoint stops honouring
 * it: measured against the live API, a limit above ~480 returns **zero rows
 * with a success code**, not an error. Nothing in the response says the request
 * was refused, so a paging loop reads the empty page as the end of history and
 * silently returns a fraction of the candles it was asked for.
 *
 * 200 is comfortably inside the working range at every depth that answers at
 * all. Slower paging is a far better failure than a backtest that quietly runs
 * on the last six weeks of data.
 */
const PAGED_LIMIT = 200;

/**
 * How far back this endpoint reaches.
 *
 * Roughly 60 days, and it is the same for every limit tested from 50 to 1000:
 * beyond that `endTime` returns nothing. The live window is 900 hourly candles
 * — about 37 days — so the site is served well within reach, but a request for
 * deep history cannot be filled from here and would be silently short.
 */
const REACH_MS = 60 * 24 * 3_600_000;

/**
 * Codes that mean the request itself is wrong, so trying it again is pointless
 * and the honest answer is a provider error rather than an outage. Anything
 * else non-zero is treated as an outage: Bitget publishes no table of business
 * codes, and guessing a transient one to be permanent would strand the venue
 * without ever being retried.
 */
const REQUEST_ERROR_CODES = new Set([
    '40034', // Parameter <symbol> does not exist
    '40053', // limit outside (0, 1000]
    '400100', // Parameter verification failed
    '400171', // k-line time range not supported
    '40404', // Request URL NOT FOUND
]);

const BitgetNumberSchema = z
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

const BitgetNonNegativeSchema = BitgetNumberSchema.refine(
    (value) => value >= 0,
    {
        message: 'Value must not be negative',
    },
);

/**
 * `[timestamp, open, high, low, close, baseVolume, quoteVolume, usdtVolume]`.
 *
 * The trailing `unknown` matters: the row is a fixed-width array, so a schema
 * without it insists the venue send exactly six fields, and a venue that
 * appends a quote-volume pair to the row it already shipped would be read as a
 * contract violation rather than as the data it is. Only the leading fields are
 * read, and only those are constrained.
 */
const BitgetCandleRowSchema = z.tuple(
    [
        BitgetNonNegativeSchema,
        BitgetNonNegativeSchema,
        BitgetNonNegativeSchema,
        BitgetNonNegativeSchema,
        BitgetNonNegativeSchema,
        BitgetNonNegativeSchema,
    ],
    z.unknown(),
);

const BitgetCandlesSchema = z.array(BitgetCandleRowSchema).max(MAX_CANDLE_LIMIT);

const BitgetTickerSchema = z.object({
    symbol: z.string(),
    lastPr: BitgetNonNegativeSchema,
});

/**
 * The envelope. `code` is checked before `data` is even looked at, because on
 * failure `data` is null and the shape below would fail for the wrong reason.
 */
const BitgetResponseSchema = z.object({
    code: z.string(),
    msg: z.string().optional(),
    data: z.unknown().optional(),
});

export interface BitgetProviderOptions {
    baseUrl?: string;
    symbol?: string;
    /** Binance-style, e.g. `1h`. Translated to Bitget's own spelling. */
    candleInterval?: string;
    defaultCandleLimit?: number;
}

export class BitgetProvider implements MarketDataProvider {
    private readonly baseUrl: string;
    private readonly symbol: string;
    private readonly interval: { granularity: string; durationMs: number };
    private readonly defaultCandleLimit: number;

    constructor(options: BitgetProviderOptions = {}) {
        this.baseUrl = (options.baseUrl ?? 'https://api.bitget.com').replace(/\/+$/, '');
        this.symbol = options.symbol ?? marketConfig.symbol;
        this.defaultCandleLimit =
            options.defaultCandleLimit ?? marketConfig.defaultCandleLimit;

        const requested = options.candleInterval ?? marketConfig.candleInterval;
        const mapped = GRANULARITIES[requested];

        if (mapped === undefined) {
            throw new MarketDataError(
                `Bitget does not support the ${requested} candle interval`,
                {
                    code: 'MARKET_PROVIDER_ERROR',
                    cause: {
                        provider: 'bitget',
                        requestedInterval: requested,
                        supported: Object.keys(GRANULARITIES).join(', '),
                    },
                },
            );
        }

        this.interval = mapped;
    }

    async getPrice(): Promise<AssetPrice> {
        const url =
            `${this.baseUrl}${TICKERS_ENDPOINT}` +
            `?symbol=${encodeURIComponent(this.symbol)}`;

        try {
            const response = await sendProviderRequest({
                provider: 'bitget',
                url,
                endpoint: TICKERS_ENDPOINT,
            });

            if (!response.ok) {
                throw new MarketDataError(
                    `Bitget price request failed with HTTP ${response.status}`,
                    {
                        code: response.status === 429 || response.status >= 500
                            ? 'MARKET_DATA_UNAVAILABLE'
                            : 'MARKET_PROVIDER_ERROR',
                        statusCode: response.status === 429 || response.status >= 500
                            ? 503
                            : 502,
                        cause: {
                            provider: 'bitget',
                            endpoint: TICKERS_ENDPOINT,
                            httpStatus: response.status,
                        },
                    },
                );
            }

            const body = BitgetResponseSchema.parse(await response.json());

            assertBitgetSuccess(body, TICKERS_ENDPOINT);

            const ticker = BitgetTickerSchema.parse(
                firstItem(body.data, TICKERS_ENDPOINT),
            );

            return {
                symbol: ticker.symbol,
                price: ticker.lastPr,
            };
        } catch (error) {
            throw normalizeBitgetError(
                error,
                TICKERS_ENDPOINT,
                'Failed to fetch market price from Bitget',
            );
        }
    }

    async getCandles(
        limit: number = this.defaultCandleLimit,
    ): Promise<Candle[]> {
        return this.fetchCandles(limit);
    }

    /**
     * Pages backwards through history, newest page first.
     *
     * A request for more than the live window has to ask for the older part
     * explicitly, or a backtest spends its whole sample on the indicator
     * warm-up and has nothing left to evaluate.
     *
     * The walk stops on an empty page, but an empty page is also what this
     * endpoint returns when the request is out of reach rather than out of
     * data. The two are told apart by the reach: once the walk is asking about
     * a time this endpoint does not serve, an empty page is the expected
     * answer and the loop would otherwise keep asking.
     */
    async getHistoricalCandles(limit: number): Promise<Candle[]> {
        if (limit <= MAX_CANDLE_LIMIT) {
            return this.fetchCandles(limit);
        }

        const pageSize = PAGED_LIMIT;
        const collected: Candle[] = [];
        const horizon = Date.now() - REACH_MS;

        let oldestSeen = Number.POSITIVE_INFINITY;

        while (collected.length < limit) {
            const page = await this.fetchCandles(
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

            if (oldest <= horizon) {
                // Past what this endpoint serves, so the next page is empty by
                // construction rather than because the data ran out.
                break;
            }
        }

        return collected
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(-limit);
    }

    private async fetchCandles(
        limit: number,
        endTime?: number,
    ): Promise<Candle[]> {
        const url =
            `${this.baseUrl}${CANDLES_ENDPOINT}` +
            `?symbol=${encodeURIComponent(this.symbol)}` +
            `&granularity=${encodeURIComponent(this.interval.granularity)}` +
            `&limit=${limit}` +
            (endTime === undefined ? '' : `&endTime=${endTime}`);

        try {
            const response = await sendProviderRequest({
                provider: 'bitget',
                url,
                endpoint: CANDLES_ENDPOINT,
            });

            if (!response.ok) {
                throw new MarketDataError(
                    `Bitget klines request failed with HTTP ${response.status}`,
                    {
                        code: response.status === 429 || response.status >= 500
                            ? 'MARKET_DATA_UNAVAILABLE'
                            : 'MARKET_PROVIDER_ERROR',
                        statusCode: response.status === 429 || response.status >= 500
                            ? 503
                            : 502,
                        cause: {
                            provider: 'bitget',
                            endpoint: CANDLES_ENDPOINT,
                            httpStatus: response.status,
                        },
                    },
                );
            }

            const body = BitgetResponseSchema.parse(await response.json());

            assertBitgetSuccess(body, CANDLES_ENDPOINT);

            const rows = BitgetCandlesSchema.parse(body.data);

            return toCandles(rows, this.interval.durationMs, Date.now());
        } catch (error) {
            throw normalizeBitgetError(
                error,
                CANDLES_ENDPOINT,
                'Failed to fetch market candles from Bitget',
            );
        }
    }
}

/**
 * Throws on a business-level failure, which the transport cannot see because
 * the status line says 200.
 */
function assertBitgetSuccess(
    body: { code: string; msg?: string | undefined },
    endpoint: string,
): void {
    if (body.code === SUCCESS_CODE) {
        return;
    }

    const isRequestError = REQUEST_ERROR_CODES.has(body.code);

    throw new MarketDataError(
        `Bitget rejected the request: ${body.msg ?? 'no message'}`,
        {
            code: isRequestError ? 'MARKET_PROVIDER_ERROR' : 'MARKET_DATA_UNAVAILABLE',
            cause: {
                provider: 'bitget',
                endpoint,
                bitgetCode: body.code,
                bitgetMessage: body.msg ?? null,
            },
        },
    );
}

function firstItem(data: unknown, endpoint: string): unknown {
    const parsed = z.array(z.unknown()).min(1).parse(data);

    return parsed[0];
}

/**
 * Bitget's last row is the candle in progress, and its close keeps moving, so
 * the primary drops it. The same rule is applied here from the candle's own
 * start time, because this venue sends no close time.
 *
 * It matters for more than tidiness: the two providers must agree on how many
 * candles a series holds, or switching venues mid-outage would change what the
 * indicators were computed from and the signal would move for a reason that
 * has nothing to do with the market.
 */
function toCandles(
    rows: Array<[number, number, number, number, number, number, ...unknown[]]>,
    durationMs: number,
    now: number,
): Candle[] {
    const candles: Candle[] = [];

    for (const row of rows) {
        const [timestamp, open, high, low, close, volume] = row;

        if (timestamp + durationMs > now) {
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

function normalizeBitgetError(
    error: unknown,
    endpoint: string,
    fallbackMessage: string,
): MarketDataError {
    if (error instanceof MarketDataError) {
        return error;
    }

    if (error instanceof DOMException && error.name === 'TimeoutError') {
        return new MarketDataError(
            'Market data provider timed out',
            {
                code: 'MARKET_PROVIDER_TIMEOUT',
                cause: {
                    provider: 'bitget',
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
                    provider: 'bitget',
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
                provider: 'bitget',
                endpoint,
                originalError: toLogSafeCause(error),
            },
        },
    );
}

function toLogSafeCause(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }

    return typeof error;
}
