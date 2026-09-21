import { z } from 'zod';

const MarketConfigSchema = z.object({
    provider: z.enum(['binance', 'mock']),
    baseUrl: z.url(),
    symbol: z.string().min(1),
    candleInterval: z.string().min(1),
    defaultCandleLimit: z.coerce.number().int().positive(),
    requestTimeoutMs: z.coerce.number().int().positive(),
});

export type MarketConfig = z.infer<typeof MarketConfigSchema>;

export const marketConfig: MarketConfig = MarketConfigSchema.parse({
    provider:
        process.env.MARKET_PROVIDER ??
        'binance',

    baseUrl:
        process.env.MARKET_BASE_URL ??
        'https://data-api.binance.vision',

    symbol:
        process.env.MARKET_SYMBOL ??
        'BTCUSDT',

    candleInterval:
        process.env.MARKET_CANDLE_INTERVAL ??
        '1h',

    defaultCandleLimit:
        process.env.MARKET_DEFAULT_CANDLE_LIMIT ??
        '300',

    requestTimeoutMs:
        process.env.MARKET_REQUEST_TIMEOUT_MS ??
        '10000',
});
