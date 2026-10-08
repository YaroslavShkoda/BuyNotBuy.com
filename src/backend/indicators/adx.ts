import type { Candle } from '../types/market.js';

/**
 * Average Directional Index: how much of the movement has a direction.
 *
 * ADX answers a question none of the other indicators ask. Every one of them
 * says which way and by how much; ADX says whether there is a way at all. A
 * market with a strong +DI and a strong -DI is a market going nowhere, and an
 * indicator set that only measures direction reads that as agreement rather
 * than as the absence of a trend — which is the one situation where a signal is
 * least useful and most confidently delivered.
 *
 * Deliberately not a vote, and the reason is the same one that keeps Bollinger
 * out: ADX has no direction. It is an unsigned strength. Turning it into a
 * vote would mean pairing it with something else and calling the pair one
 * indicator, and the agreement figure would then count one piece of evidence
 * twice.
 */

interface DirectionalMovement {
    /** Strength of the upward direction, 0..100. */
    plusDI: number;
    /** Strength of the downward direction, 0..100. */
    minusDI: number;
    /**
     * Trend strength regardless of direction, 0..100.
     *
     * Below 25 is conventionally "no trend", above 25 a trend worth trading and
     * above 50 an unusually strong one. The thresholds live in the
     * configuration, because they are a convention rather than a property of
     * the arithmetic.
     */
    adx: number;
}

const DIRECTIONAL_RANGE_OFFSET = 1;

export function calculateADX(
    candles: Candle[],
    period: number,
): DirectionalMovement {
    if (candles.length === 0) {
        throw new Error('ADX requires at least one candle');
    }

    if (period <= 0) {
        throw new Error('ADX period must be greater than 0');
    }

    // Wilder needs the first true range, which needs a previous candle, plus
    // `period` smoothings on top. One bar short of this and the recursion
    // never runs, which produces an ADX that looks finished and is really the
    // average of a handful of bars.
    if (candles.length < period * 2 + 1) {
        throw new Error(`ADX requires at least ${period * 2 + 1} candles`);
    }

    const trueRanges: number[] = [];
    const plusMoves: number[] = [];
    const minusMoves: number[] = [];

    // Starting at 1 rather than 0: the first candle has no previous close, so
    // it contributes no directional range. Including it would make the reading
    // a function of where the window happens to start.
    for (
        let index = DIRECTIONAL_RANGE_OFFSET;
        index < candles.length;
        index += 1
    ) {
        const candle = candles[index];
        const previous = candles[index - 1];

        if (candle === undefined || previous === undefined) {
            continue;
        }

        trueRanges.push(
            Math.max(
                candle.high - candle.low,
                Math.abs(candle.high - previous.close),
                Math.abs(candle.low - previous.close),
            ),
        );

        const up = candle.high - previous.high;
        const down = previous.low - candle.low;

        // Both can be positive, and then the bar has an inside day and no
        // directional information at all. Counting it as an up move because it
        // checked the first box is how a ranging market accumulates a trend.
        plusMoves.push(up > down && up > 0 ? up : 0);
        minusMoves.push(down > up && down > 0 ? down : 0);
    }

    if (trueRanges.length < period) {
        throw new Error(
            `ADX requires at least ${period} directional ranges`,
        );
    }

    let smoothedRange = sum(trueRanges, 0, period);
    let smoothedPlus = sum(plusMoves, 0, period);
    let smoothedMinus = sum(minusMoves, 0, period);

    const dx: number[] = [];
    const first = directionalIndex(
        smoothedPlus,
        smoothedMinus,
        smoothedRange,
    );

    if (first !== null) {
        dx.push(first);
    }

    for (let index = period; index < trueRanges.length; index += 1) {
        smoothedRange =
            smoothedRange - smoothedRange / period + (trueRanges[index] ?? 0);
        smoothedPlus =
            smoothedPlus - smoothedPlus / period + (plusMoves[index] ?? 0);
        smoothedMinus =
            smoothedMinus - smoothedMinus / period + (minusMoves[index] ?? 0);

        const value = directionalIndex(
            smoothedPlus,
            smoothedMinus,
            smoothedRange,
        );

        if (value !== null) {
            dx.push(value);
        }
    }

    if (dx.length === 0) {
        // Every window had no range or no directional balance at all, so there
        // is nothing to smooth. A market that did not move reads zero, and it
        // is the one case where throwing would be wrong: this is a real
        // reading, and a perfectly flat series is what a fixture, a halted
        // instrument and a data problem all look like.
        return { plusDI: 0, minusDI: 0, adx: 0 };
    }

    if (dx.length < period) {
        throw new Error(
            `ADX requires ${period} directional indexes, found ${dx.length}`,
        );
    }

    const adx =
        sum(dx, dx.length - period, dx.length) / period;

    const { plusDI, minusDI } = smoothedStrength(
        smoothedPlus,
        smoothedMinus,
        smoothedRange,
    );

    return { plusDI, minusDI, adx };
}

/**
 * The DX reading for one smoothed window.
 *
 * Null when the window has no range at all — a perfectly flat series, which
 * exists in fixtures and does not exist in a market, and which would otherwise
 * divide by zero and produce an infinity that then poisons the average.
 */
function directionalIndex(
    plus: number,
    minus: number,
    range: number,
): number | null {
    if (range === 0) {
        return null;
    }

    const plusDI = (plus / range) * 100;
    const minusDI = (minus / range) * 100;
    const total = plusDI + minusDI;

    if (total === 0) {
        return null;
    }

    return (Math.abs(plusDI - minusDI) / total) * 100;
}

function smoothedStrength(
    plus: number,
    minus: number,
    range: number,
): { plusDI: number; minusDI: number } {
    if (range === 0) {
        return { plusDI: 0, minusDI: 0 };
    }

    return { plusDI: (plus / range) * 100, minusDI: (minus / range) * 100 };
}

function sum(values: number[], from: number, to: number): number {
    let total = 0;

    for (let index = from; index < to; index += 1) {
        total += values[index] ?? 0;
    }

    return total;
}
