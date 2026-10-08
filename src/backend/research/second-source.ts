/**
 * Is any of this an artifact of one exchange?
 *
 * Everything measured in this project so far has been measured on Binance.
 * That is a reasonable default — it is the venue the system trades — and it is
 * also a single sample of a thing that varies by venue. This project's own
 * fixture notes put the two apart at 1.24% on closes and up to 12.54% on
 * highs, which is not rounding. A Donchian channel is built from highs and
 * lows, so a rule that breaks out on one source's high puts its stop in a
 * different place on the other's, and a rule whose edges are the maximum and
 * the minimum is exactly the rule most exposed to that disagreement.
 *
 * So both sources, over the *same* dates. Not the same number of bars —
 * comparing Yahoo's extra five years of 2018–2020 against Binance's 2021
 * start would be comparing sources and periods at once, and this project has
 * already made that mistake twice for the price of one bad assumption each.
 * Only the overlap counts: 2021-01-01 to 2026-09-25, 2094 Binance bars against
 * 2071 Yahoo ones.
 *
 * **The answer is that the findings are not artifacts of the venue, and that
 * is the more useful of the two possible answers.** The permutation p-values,
 * the sign of every rule, and the fact that all of them trail buy-and-hold
 * reproduce on the second source. Nothing here depends on Binance having said
 * something Binance-specific.
 *
 * What does not survive is a rank. `donchian-calm-gated` is the best of the
 * three Donchian variants on Binance and not on Yahoo, and the two sources
 * disagree about which month of 2021 was the top. That is what two venues
 * disagreeing about means, and it is the reason no rule in this project can be
 * chosen by a table.
 *
 * See `second-source.cli.ts` for the numbers.
 */

import type { Candle } from '../types/market.js';

import type { PermutationResult } from './signal-power.js';
import { forwardReturns, permutationPValue } from './signal-power.js';

interface SourceComparison {
    readonly label: string;
    readonly bars: number;
    readonly first: number;
    readonly last: number;
    /** Mean signed difference in close, in percent, this source minus the other. */
    readonly meanCloseGap: number;
    /** Mean absolute difference in high, in percent. */
    readonly meanHighGap: number;
    /** The largest absolute difference in high, in percent. */
    readonly worstHighGap: number;
    readonly worstHighAt: number;
}

/**
 * Overlapping slice of two series, matched on the *day*, so periods cannot differ.
 *
 * On the timestamp, not on the number: Yahoo's day boundary is 12:00 UTC and
 * Binance's is 00:00, so the two series label the same session twelve hours
 * apart. Matching timestamps finds nothing at all, and "nothing at all" is a
 * silent zero rather than an error — the first version of this returned an
 * empty overlap and printed a table of 0.00% gaps that looked like a
 * measurement.
 */
export function overlap(
    a: readonly Candle[],
    b: readonly Candle[],
): { readonly a: Candle[]; readonly b: Candle[] } {
    const left = new Map(b.map((candle) => [dayOf(candle.timestamp), candle]));
    const inA: Candle[] = [];
    const inB: Candle[] = [];

    for (const candle of a) {
        const partner = left.get(dayOf(candle.timestamp));

        if (partner !== undefined) {
            inA.push(candle);
            inB.push(partner);
        }
    }

    return { a: inA, b: inB };
}

/** The UTC date of a bar, at day resolution, in a form both sources agree on. */
export function dayOf(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
}

export function compareSources(
    a: readonly Candle[],
    b: readonly Candle[],
    label: string,
): SourceComparison {
    const pair = overlap(a, b);

    let closeSum = 0;
    let highSum = 0;
    let worstHighGap = 0;
    let worstHighAt = 0;

    pair.a.forEach((left, index) => {
        const right = pair.b[index]!;

        closeSum += (left.close / right.close - 1) * 100;
        const gap = Math.abs(left.high / right.high - 1) * 100;

        highSum += gap;
        if (gap > worstHighGap) {
            worstHighGap = gap;
            worstHighAt = left.timestamp;
        }
    });

    return {
        label,
        bars: pair.a.length,
        first: pair.a[0]?.timestamp ?? 0,
        last: pair.a[pair.a.length - 1]?.timestamp ?? 0,
        meanCloseGap: closeSum / Math.max(1, pair.a.length),
        meanHighGap: highSum / Math.max(1, pair.a.length),
        worstHighGap,
        worstHighAt,
    };
}

/**
 * Runs one signal through the same permutation test on both sources.
 *
 * The point is not that the p-value should be equal. Two venues produce two
 * series, and a p-value is a statement about one. The point is that both
 * should fail to reject, and that if one rejected and one did not, the
 * conclusion would be about the venue rather than the rule.
 *
 * The signal is a boolean — did the rule act on this bar — because that is
 * what `permutationPValue` tests: the values it fired on against the values it
 * skipped. SHORT and LONG both count as acting; what is being asked is whether
 * the rule knows anything about direction.
 *
 * `signalOn` is given the whole series and returns a whole-length array, and
 * the alignment is done here. The first version asked the caller to return only
 * the measured window, which is a contract one has to know: a caller that
 * returned the whole thing got a length mismatch, and a caller that got it
 * wrong in the other direction — by slicing the wrong side — would have
 * compared one series' prices against another series' signals without anything
 * noticing. Wrong numbers should be loud, and both of these were quiet.
 */
export function pValueOnBoth(
    signalOn: (candles: readonly Candle[]) => boolean[],
    a: readonly Candle[],
    b: readonly Candle[],
    warmup: number,
    draws = 5000,
): { readonly a: PermutationResult; readonly b: PermutationResult } {
    const one = (candles: readonly Candle[]): PermutationResult => {
        // The last bar has no forward return, so neither does its signal. It
        // is dropped rather than counted as a miss: a rule that fired on the
        // final bar has not made a bad call, it has made no call that can be
        // scored. Leaving it in also made the two arrays one element apart,
        // which is the kind of off-by-one that a length check catches and a
        // reader does not.
        const signal = signalOn(candles).slice(warmup, -1);
        const returns = forwardReturns(candles.map((candle) => candle.close)).slice(
            warmup,
            warmup + signal.length,
        );

        return permutationPValue(returns, signal, { draws, seed: 0x5eed_1a7e });
    };

    return { a: one(a), b: one(b) };
}
