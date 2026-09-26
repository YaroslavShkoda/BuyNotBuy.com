import type { Candle } from '../types/market.js';

/**
 * Average True Range, in the same units as the price.
 *
 * Unlike the other three indicators this one is not a direction and does not
 * vote. It answers a different question — how far price is travelling — and a
 * market that is going nowhere can have a low ATR while every directional
 * indicator agrees, which is exactly the case a trader most needs to notice.
 *
 * Returned as a fraction of price rather than in currency, so a reading can be
 * compared between instruments and does not need reinterpreting when the symbol
 * changes. The dashboard shows the percentage, because "ATR 1.2%" is meaningful
 * and "ATR 640" is not.
 */
export function calculateATR(candles: Candle[], period: number): number {
    if (candles.length === 0) {
        throw new Error('ATR requires at least one candle');
    }

    if (period <= 0) {
        throw new Error('ATR period must be greater than 0');
    }

    if (candles.length < period + 1) {
        throw new Error(`ATR requires at least ${period + 1} candles`);
    }

    const trueRanges: number[] = [];

    for (let index = 1; index < candles.length; index += 1) {
        const candle = candles[index];
        const previous = candles[index - 1];

        if (candle === undefined || previous === undefined) {
            continue;
        }

        // The first candle of a series has no previous close, so it contributes
        // no true range. Starting the loop at 1 rather than 0 is not a detail:
        // including it would make the first reading a function of where the
        // window happens to start.
        trueRanges.push(
            Math.max(
                candle.high - candle.low,
                Math.abs(candle.high - previous.close),
                Math.abs(candle.low - previous.close),
            ),
        );
    }

    const recent = trueRanges.slice(-period);
    const last = candles[candles.length - 1];

    if (last === undefined) {
        throw new Error('ATR requires at least one candle');
    }

    // A zero close cannot yield a ratio, and returning zero would read as
    // "no volatility" rather than "no price to measure against".
    if (last.close <= 0) {
        throw new Error('ATR cannot be expressed as a percentage of a zero price');
    }

    const total = recent.reduce((sum, value) => sum + value, 0);

    return total / recent.length / last.close;
}
