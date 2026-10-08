import { MarketDataError } from '../../errors/market-data.error.js';

interface RateLimitDecision {
    allowed: boolean;
    remaining: number;
    /** Epoch milliseconds at which the current window ends. */
    resetAt: number;
}

/** The database surface the limiter needs, injectable so a test can fake it. */
export interface RateLimiterDatabase {
    query: <T>(
        text: string,
        values?: readonly unknown[],
    ) => Promise<{ rows: T[] }>;
}

interface PostgresRateLimiterOptions {
    max: number;
    windowMs: number;
    database: RateLimiterDatabase;
    now?: () => number;
}

/**
 * A fixed-window counter per client, one row per client per window, in the
 * database.
 *
 * The window is still a fixed one — the bookkeeping is one row per client per
 * window, so the limiter itself cannot become the thing that exhausts memory,
 * and the known cost of a burst of up to `2 * max` across a boundary stands.
 * What changed is where the counter lives: in process memory the budget was
 * the limit times the number of instances, which meant the more of the system
 * there was, the less the limit meant. Here every instance asks the same row.
 *
 * The write is a single upsert. `ON CONFLICT DO UPDATE` takes the row lock,
 * so two instances answering the same client in the same millisecond
 * serialize, and each reads back the total rather than its own guess — the
 * counting and the reading are one statement, and nothing can interleave
 * between them.
 */
export class PostgresRateLimiter {
    #max: number;
    #windowMs: number;
    #now: () => number;
    #database: RateLimiterDatabase;

    constructor(options: PostgresRateLimiterOptions) {
        this.#max = options.max;
        this.#windowMs = options.windowMs;
        this.#database = options.database;
        this.#now = options.now ?? (() => Date.now());
    }

    async consume(key: string): Promise<RateLimitDecision> {
        const now = this.#now();

        // The aligned start of the window, not the first request's timestamp:
        // every process derives the same value from the same wall clock, and
        // that is what lands their writes on one row.
        const windowStart = Math.floor(now / this.#windowMs) * this.#windowMs;

        const result = await this.#database.query<{ count: number }>(
            `INSERT INTO rate_limit_window (bucket, window_start, count)
                  VALUES ($1, $2, 1)
             ON CONFLICT (bucket, window_start)
             DO UPDATE SET count = rate_limit_window.count + 1
             RETURNING count`,
            [key, windowStart],
        );

        const count = result.rows[0]?.count ?? 1;

        return {
            allowed: count <= this.#max,
            remaining: Math.max(0, this.#max - count),
            resetAt: windowStart + this.#windowMs,
        };
    }

    /**
     * Deletes every window.
     *
     * A test affordance, kept from the in-memory limiter it replaced, and the
     * honest way to say it: production never calls this, and a test that
     * needs a clean counter asks the same class a real client asks.
     */
    async reset(): Promise<void> {
        await this.#database.query('DELETE FROM rate_limit_window');
    }
}

export function rateLimitError(retryAfterSeconds: number): MarketDataError {
    return new MarketDataError(
        'Too many requests from this client',
        {
            code: 'RATE_LIMITED',
            statusCode: 429,
            retryAfterSeconds: Math.max(1, retryAfterSeconds),
        },
    );
}
