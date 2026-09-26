import { MarketDataError } from '../../errors/market-data.error.js';

export interface RateLimitOptions {
    max: number;
    windowMs: number;
    now?: () => number;
}

export interface RateLimitDecision {
    allowed: boolean;
    remaining: number;
    /** Epoch milliseconds at which the current window ends. */
    resetAt: number;
}

interface Window {
    count: number;
    resetAt: number;
}

/**
 * A fixed-window counter per client.
 *
 * Fixed windows are chosen over sliding ones on purpose: the bookkeeping is a
 * single map entry per client, so the limiter itself cannot become the thing
 * that exhausts memory. The known cost is a burst of up to `2 * max` across a
 * window boundary, which is an acceptable trade for a public dashboard.
 */
export class FixedWindowRateLimiter {
    #max: number;
    #windowMs: number;
    #now: () => number;
    #windows = new Map<string, Window>();

    constructor(options: RateLimitOptions) {
        this.#max = options.max;
        this.#windowMs = options.windowMs;
        this.#now = options.now ?? (() => Date.now());
    }

    consume(key: string): RateLimitDecision {
        const now = this.#now();
        const existing = this.#windows.get(key);

        if (existing === undefined || existing.resetAt <= now) {
            const window: Window = { count: 1, resetAt: now + this.#windowMs };

            this.#windows.set(key, window);
            this.#sweep(now);

            return {
                allowed: true,
                remaining: this.#max - 1,
                resetAt: window.resetAt,
            };
        }

        existing.count += 1;

        return {
            allowed: existing.count <= this.#max,
            remaining: Math.max(0, this.#max - existing.count),
            resetAt: existing.resetAt,
        };
    }

    reset(): void {
        this.#windows.clear();
    }

    get size(): number {
        return this.#windows.size;
    }

    /**
     * Drops windows that have already expired.
     *
     * Without this the map grows with every distinct address ever seen, so a
     * flood from spoofed or rotating addresses would accumulate forever.
     * Sweeping on write rather than on a timer keeps the limiter free of
     * background work.
     */
    #sweep(now: number): void {
        if (this.#windows.size <= 1000) {
            return;
        }

        for (const [key, window] of this.#windows) {
            if (window.resetAt <= now) {
                this.#windows.delete(key);
            }
        }
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
