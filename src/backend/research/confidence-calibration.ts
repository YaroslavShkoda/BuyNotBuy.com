/**
 * Does `confidence` mean what a reader takes it to mean?
 *
 * Every module in this project returns a number between 0 and 1 called
 * confidence, it goes into the telemetry, and it is shown to whoever is looking
 * at the dashboard. `donchian.ts` produces it through `breakoutStrength`, which
 * measures the distance past the level in units of ATR and clamps it to 0.95.
 * That is a real quantity and a sensible one. It is not a probability, and
 * nothing has ever checked whether it is even *monotone* — whether trading
 * only the bars where the number is high does better than trading all of them.
 *
 * If it is not monotone, the number is decoration: it varies, it looks
 * meaningful, and it carries no information. The dashboard can still show it;
 * the report cannot call it confidence without this.
 *
 * The test is a reliability diagram, which is the standard way to ask: bin the
 * bars by the number the rule produced, and within each bin measure the share
 * that went up. A calibrated number is a diagonal — a bin at 0.6 wins 60% of
 * the time. A monotone but badly scaled number is a rising curve that is
 * nowhere near the diagonal. A number with nothing in it is flat.
 *
 * **The answer is that nobody can tell, and the reason is a number worth
 * looking at.** `donchian-20` produced 131 LONG signals across five and a half
 * years of daily bars. Of those, 3 sit in 0.50–0.60, 6 in 0.60–0.70 and 6 in
 * 0.70–0.80. A win share computed from six bars takes one of six values, and a
 * calibration read off that is a calibration of the bin edges.
 *
 * That is the whole finding, and it is not a comfortable one. The project has
 * spent twenty steps building machinery to decide whether a number called
 * confidence means anything, and the answer is that five and a half years of
 * daily bars produce too few confident signals to ask. The first version of
 * this file reported a boolean and it said `monotone` for every rule on the
 * market — it was reporting the bin boundaries, not the rules.
 *
 * So the number stays, and it keeps being shown, because it is a real quantity
 * — the distance past the level in units of ATR, clamped at 0.95 — and the
 * alternative is showing nothing. What must stop is the word. Nothing in this
 * repository has established that it predicts, and until roughly ten times
 * this many signals exist, nothing can.
 */

import type { StrategyModule } from '../strategies/types.js';
import type { Candle } from '../types/market.js';

interface Bin {
    readonly label: string;
    readonly lower: number;
    readonly upper: number;
}

/** Fixed, round bins, because a binning chosen after seeing the data is a result. */
const CONFIDENCE_BINS: readonly Bin[] = [
    { label: '0.00–0.10', lower: 0, upper: 0.1 },
    { label: '0.10–0.20', lower: 0.1, upper: 0.2 },
    { label: '0.20–0.30', lower: 0.2, upper: 0.3 },
    { label: '0.30–0.40', lower: 0.3, upper: 0.4 },
    { label: '0.40–0.50', lower: 0.4, upper: 0.5 },
    { label: '0.50–0.60', lower: 0.5, upper: 0.6 },
    { label: '0.60–0.70', lower: 0.6, upper: 0.7 },
    { label: '0.70–0.80', lower: 0.7, upper: 0.8 },
    { label: '0.80–1.00', lower: 0.8, upper: 1.01 },
];

interface BinReading {
    readonly label: string;
    readonly bars: number;
    /** Share of bars in this bin whose next bar went up. */
    readonly winShare: number;
    /** Mean forward return in this bin. */
    readonly meanForward: number;
}

/**
 * Pairs every bar the strategy acted on with the confidence it gave and the
 * move that followed.
 *
 * Takes the module rather than the bench adapter, because the adapter collapses
 * a decision to `1 | 0 | -1` and throws away exactly the number under
 * investigation. The module's context is index-free by design, so the current
 * bar is identified by its own timestamp against a map built once — the same
 * trick the resolution work used, and no more leakage than the bar carries.
 *
 * The forward return is measured from the bar the signal was produced on, not
 * from the bar it was filled on, because that is the decision the number
 * accompanied. Mixing the two would make the calibration depend on the
 * execution model, and the execution model has already moved once this month.
 */
export function collectConfidences(
    module: StrategyModule,
    candles: readonly Candle[],
    options: { readonly forwardBars?: number } = {},
): Array<{ readonly confidence: number; readonly forward: number }> {
    const forwardBars = options.forwardBars ?? 1;
    const position = new Map<number, number>();

    candles.forEach((candle, index) => {
        position.set(candle.timestamp, index);
    });

    const rows: Array<{ confidence: number; forward: number }> = [];

    for (let index = 0; index < candles.length - forwardBars; index += 1) {
        const visible = candles.slice(0, index + 1);
        const at = position.get(visible[visible.length - 1]!.timestamp);

        // The slice is built from the same array, so this cannot happen. It is
        // checked because a silent `undefined` here would produce a decision
        // for the wrong bar and a calibration that measures nothing.
        if (at !== index) {
            continue;
        }

        const decision = module.evaluate({
            candles: visible,
            price: visible[visible.length - 1]!.close,
        });

        if (decision.direction !== 'LONG') {
            continue;
        }

        const here = visible[visible.length - 1]!.close;
        const later = candles[index + forwardBars]!.close;

        if (here <= 0) {
            continue;
        }

        rows.push({ confidence: decision.confidence, forward: later / here - 1 });
    }

    return rows;
}

/**
 * Minimum bars in a bin before its win share is quoted at all.
 *
 * Six bars produce shares of 0%, 33%, 50%, 67%, 83% and 100%, and a
 * calibration read off that is a calibration of the bin boundaries. Chosen as
 * the smallest count at which the share is a rate in any useful sense; not
 * derived, and the point of stating it is that it is a choice.
 */
export const MINIMUM_BIN_BARS = 20;

export type Verdict =
    /** The upper half of the range wins more often than the lower half. */
    | 'monotone'
    /** It does not. The number is decoration. */
    | 'flat'
    /** Too few bars in the confident bins to say either way. */
    | 'too-few-bars';

export interface Reliability {
    readonly bins: readonly BinReading[];
    readonly verdict: Verdict;
    /** Whether the verdict rests on enough bars to be worth reading. */
    readonly measurable: boolean;
    /** The most bars any single bin holds. */
    readonly largestBin: number;
    /** The most bars in the top half of the confidence range. */
    readonly topHalfBars: number;
    readonly bestBin: BinReading | null;
    readonly worstBin: BinReading | null;
}

/**
 * Bins the readings and says whether the curve rises.
 *
 * The verdict is a three-way answer rather than a boolean because a boolean
 * cannot distinguish "measured, and it is flat" from "there were six bars up
 * there, so nobody knows". The first version of this returned a boolean, it
 * reported `monotone` for every rule on the market, and it was reporting the
 * bin boundaries: `donchian-20` on BTCUSDT holds 131 signals in total, of which
 * 3, 6 and 6 sit above a confidence of 0.5.
 */
export function reliability(
    rows: ReadonlyArray<{ readonly confidence: number; readonly forward: number }>,
): Reliability {
    const readings: BinReading[] = CONFIDENCE_BINS.map((bin) => {
        const inside = rows.filter(
            (row) => row.confidence >= bin.lower && row.confidence < bin.upper,
        );
        const wins = inside.filter((row) => row.forward > 0).length;

        return {
            label: bin.label,
            bars: inside.length,
            winShare: inside.length === 0 ? Number.NaN : wins / inside.length,
            meanForward:
                inside.length === 0
                    ? Number.NaN
                    : inside.reduce((total, row) => total + row.forward, 0) / inside.length,
        };
    });

    const withData = readings.filter((reading) => reading.bars > 0);
    const half = Math.floor(withData.length / 2);
    const lower = withData.slice(0, half);
    const upper = withData.slice(-half);
    const topHalfBars = upper.reduce((total, reading) => total + reading.bars, 0);

    const mean = (values: readonly BinReading[]): number =>
        values.length === 0
            ? Number.NaN
            : values.reduce((total, reading) => total + reading.winShare, 0) / values.length;

    const measurable = topHalfBars >= MINIMUM_BIN_BARS;
    const verdict: Verdict = !measurable
        ? 'too-few-bars'
        : mean(upper) > mean(lower)
          ? 'monotone'
          : 'flat';

    return {
        bins: readings,
        verdict,
        measurable,
        largestBin: withData.reduce((most, reading) => Math.max(most, reading.bars), 0),
        topHalfBars,
        bestBin: withData.reduce<BinReading | null>(
            (best, reading) => (best === null || reading.winShare > best.winShare ? reading : best),
            null,
        ),
        worstBin: withData.reduce<BinReading | null>(
            (worst, reading) =>
                worst === null || reading.winShare < worst.winShare ? reading : worst,
            null,
        ),
    };
}
