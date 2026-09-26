import { z } from 'zod';

const HistoryConfigSchema = z.object({
    defaultLimit: z.coerce.number().int().positive(),
    maxLimit: z.coerce.number().int().positive(),
    maxEntries: z.coerce.number().int().positive(),
    /**
     * How many failed history writes are held for a retry. Bounded on purpose:
     * a long database outage must not become unbounded memory growth.
     */
    maxBufferedEntries: z.coerce.number().int().positive(),
    /**
     * Whether the background poller runs. On in production so history and the
     * snapshot cache stay fresh without anyone loading the page; off in tests
     * and in one-off scripts, where a timer would keep the process alive.
     */
    pollEnabled: z.boolean(),
    pollIntervalMs: z.coerce.number().int().positive(),
}).refine((config) => config.defaultLimit <= config.maxLimit, {
    message: 'History default limit must not exceed max limit',
}).refine((config) => config.maxLimit <= config.maxEntries, {
    message: 'History max limit must not exceed retained entry count',
}).refine(
    (config) => !config.pollEnabled || config.pollIntervalMs >= 1_000,
    {
        message: 'Poll interval must be at least one second',
    },
);

export type HistoryConfig = z.infer<typeof HistoryConfigSchema>;

export const historyConfig: HistoryConfig = HistoryConfigSchema.parse({
    // One entry per hour: 24 entries cover the last 24 hours.
    defaultLimit:
        process.env.HISTORY_DEFAULT_LIMIT ??
        '24',

    // 168 hours = 7 days of hourly signal states.
    maxLimit:
        process.env.HISTORY_MAX_LIMIT ??
        '168',

    // 720 hourly buckets = 30 days of retained signal history.
    maxEntries:
        process.env.HISTORY_MAX_ENTRIES ??
        '720',

    // A day of buffered writes is far more than any transient outage needs.
    maxBufferedEntries:
        process.env.HISTORY_MAX_BUFFERED_ENTRIES ??
        '24',

    pollEnabled:
        (process.env.MARKET_POLL_ENABLED ?? 'true') === 'true',

    // Hourly candles mean a faster poll buys nothing but upstream weight.
    pollIntervalMs:
        process.env.MARKET_POLL_INTERVAL_MS ??
        '60000',
});
