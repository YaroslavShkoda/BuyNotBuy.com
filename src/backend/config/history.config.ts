import { z } from 'zod';

const HistoryConfigSchema = z.object({
    databasePath: z.string().min(1),
    defaultLimit: z.coerce.number().int().positive(),
    maxLimit: z.coerce.number().int().positive(),
    maxEntries: z.coerce.number().int().positive(),
}).refine((config) => config.defaultLimit <= config.maxLimit, {
    message: 'History default limit must not exceed max limit',
}).refine((config) => config.maxLimit <= config.maxEntries, {
    message: 'History max limit must not exceed retained entry count',
});

export type HistoryConfig = z.infer<typeof HistoryConfigSchema>;

export const historyConfig: HistoryConfig = HistoryConfigSchema.parse({
    databasePath:
        process.env.HISTORY_DB_PATH ??
        './data/signal-history.db',

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
});
