import type { Candle } from '../types/market.js';

export const HOUR_MS = 3_600_000;

/**
 * A series a real provider could have returned, for tests that need one.
 *
 * Anchored to the current hour and spaced one hour apart, because the market
 * layer now checks both. That is not a stricter test than it was — it is the
 * same test. A fixture whose bars are labelled 0, 1, 2 is a series that no
 * venue has ever produced, and the checks that reject it are checking exactly
 * the thing a test double should be standing in for.
 *
 * The shape — a straight line rising by one unit a bar — is what makes a
 * metric assertion meaningful, and it is unchanged.
 */
export function currentCandles(
    count: number,
    base = 100,
    step = 1,
): Candle[] {
    const newestOpen = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const start = newestOpen - Math.max(0, count - 1) * HOUR_MS;

    return Array.from({ length: count }, (_unused, index) => {
        const close = base + index * step;

        return {
            timestamp: start + index * HOUR_MS,
            open: close,
            high: close + 2,
            low: close - 2,
            close,
            volume: 1000,
        };
    });
}
