import { z } from 'zod';

import type {
    AssetPrice,
    Candle,
} from '../../types/market.js';

import { MarketDataError } from '../../errors/market-data.error.js';
import { ProviderError } from '../../errors/provider.error.js';

import { marketConfig } from '../../config/market.config.js';
import { MAX_CANDLE_LIMIT } from '../../config/market.config.js';
import { sendBinanceRequest } from './binance-http.js';

import type { MarketDataProvider, ProviderCandles } from './market-data.provider.js';

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
 * `/api/v3/klines` is a fixed-width row: openTime, open, high, low, close,
 * base volume, closeTime, quote volume, trades, then two taker-buy figures and an
 * unused field.
 *
 * Bounded on purpose: a response larger than the provider could ever produce
 * is malformed, and materialising it first would let a bad upstream exhaust
 * memory before anything could notice.
 *
 * Eight positions are validated rather than the six that are read, because the
 * quote volume sits behind the close time — validating a prefix would leave the
 * field the panel shows as an untyped `unknown` that becomes NaN the first time
 * the venue sends something unexpected.
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
            BinanceNonNegativeSchema,
        ],
        z.unknown(),
    ),
).max(MAX_CANDLE_LIMIT);

export class BinanceProvider implements MarketDataProvider {
    readonly name = 'binance';

    readonly symbol: string;

    constructor(symbol: string = marketConfig.symbol) {
        this.symbol = symbol;
    }

    async getPrice(): Promise<AssetPrice> {        const url =
            `${marketConfig.baseUrl}` +
            PRICE_ENDPOINT +
            `?symbol=${encodeURIComponent(this.symbol)}`;

        try {
            const response = await sendBinanceRequest({
                url,
                endpoint: PRICE_ENDPOINT,
            });

            // No `response.ok` branch: the transport throws a typed
            // `ProviderError` for every non-2xx, so a status check here could
            // only ever be dead code — and the two copies that did exist had
            // already drifted, which is how a 4xx and a 429 briefly disagreed
            // about their own status code.
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

    async getAttributedCandles(
        limit: number = marketConfig.defaultCandleLimit,
    ): Promise<ProviderCandles> {
        return {
            venue: this.name,
            symbol: this.symbol,
            candles: await this.fetchKlines(limit),
        };
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
    async getHistoricalCandles(
        limit: number,
        before?: number,
    ): Promise<Candle[]> {
        if (limit <= MAX_CANDLE_LIMIT) {
            const page = await this.fetchKlines(limit, endTimeBefore(before));

            return before === undefined
                ? page
                : page.filter((candle) => candle.timestamp < before);
        }

        const pageSize = MAX_CANDLE_LIMIT;
        const collected: Candle[] = [];

        // Seeded from the caller's cursor, not from infinity. Seeding from
        // infinity would make a backfill page every one of its requests from
        // the present, so it would re-read the same thousand bars a hundred
        // times and never reach anything older than them.
        let oldestSeen =
            before ?? Number.POSITIVE_INFINITY;

        while (collected.length < limit) {
            const page = await this.fetchKlines(
                pageSize,
                endTimeBefore(oldestSeen),
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

            for (const candle of page) {
                if (candle.timestamp < oldestSeen) {
                    collected.push(candle);
                }
            }

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
                // Unreachable through the real transport, which throws a typed
                // error for every non-2xx. Kept because a test double may
                // return a `Response` instead, and the alternative — a
                // `ZodError` from parsing an error page — would report a
                // transport problem as a malformed response.
                throw httpStatusErrorOf(response.status);
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
 * The transport already turns a non-2xx into a typed `ProviderError`, so this
 * is a belt-and-braces branch for a mock or a future transport that returns
 * the `Response` instead of throwing. It goes through the same mapping rather
 * than inventing a code, so a 429 read here is a 503 exactly as it is there.
 */
function httpStatusErrorOf(status: number): ProviderError {
    return new ProviderError(
        status === 429 || status === 418
            ? 'rate_limited'
            : status >= 500
              ? 'unavailable'
              : 'invalid_response',
        `Binance request failed with HTTP ${status}`,
        {
            statusCode: status === 429 || status === 418 ? 503 : 502,
            context: { provider: 'binance', httpStatus: status },
        },
    );
}

/**
 * Binance's `endTime` is inclusive, and this contract's cursor is exclusive.
 *
 * A cursor passed through unadjusted re-fetches the bar at that exact
 * timestamp on the next page, so the walk spends a request per bar re-reading
 * the boundary instead of making progress.
 */
function endTimeBefore(timestamp: number | undefined): number | undefined {
    return timestamp === undefined || !Number.isFinite(timestamp)
        ? undefined
        : timestamp - 1;
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
            number,
            ...unknown[],
        ]
    >,
    now: number,
): Candle[] {
    const candles: Candle[] = [];

    for (const row of rows) {
        // Index 5 is the base-asset volume and is deliberately skipped: the panel
        // shows notional volume, which is index 7. Taking index 5 instead would
        // understate every figure by the price — around 84,000x on BTCUSDT —
        // while still looking like a plausible number.
        const [timestamp, open, high, low, close, , closeTime, quoteVolume] = row;

        if (closeTime > now) {
            continue;
        }

        candles.push({
            timestamp,
            open,
            high,
            low,
            close,
            volume: quoteVolume,
        });
    }

    return candles;
}

/**
 * Classifies whatever escaped the transport, and passes through what it already
 * classified.
 *
 * The pass-through is the point: the transport knows about timeouts, statuses
 * and open circuits, and a second classifier running here would be a second
 * opinion that disagrees. What is left for this function is the part only the
 * provider can see — a body that does not match the schema — and that is a
 * genuinely different failure from an outage, which is why it is
 * `invalid_response` and not `unavailable`: a retry returns the same
 * malformed body.
 */
function normalizeBinanceError(
    error: unknown,
    endpoint: string,
    fallbackMessage: string,
): MarketDataError {
    if (error instanceof MarketDataError) {
        return error;
    }

    if (isTimeoutError(error)) {
        return new ProviderError(
            'timeout',
            'Market data provider timed out',
            {
                context: {
                    provider: 'binance',
                    endpoint,
                    details: {
                        timeoutMs: marketConfig.requestTimeoutMs,
                        originalError: toLogSafeCause(error),
                    },
                },
                cause: error,
            },
        );
    }

    if (error instanceof z.ZodError) {
        return new ProviderError(
            'invalid_response',
            'Market data provider returned an unexpected response',
            {
                context: {
                    provider: 'binance',
                    endpoint,
                    // The path, not the value: a malformed price string is not
                    // a secret, but a whole rejected payload can carry enough
                    // of one to be worth not copying into a log line.
                    details: {
                        issues: error.issues
                            .slice(0, 5)
                            .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
                        issueCount: error.issues.length,
                    },
                },
                cause: error,
            },
        );
    }

    return new ProviderError(
        'unavailable',
        fallbackMessage,
        {
            context: {
                provider: 'binance',
                endpoint,
                details: { originalError: toLogSafeCause(error) },
            },
            cause: error,
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
