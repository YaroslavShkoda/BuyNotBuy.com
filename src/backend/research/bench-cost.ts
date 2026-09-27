/**
 * How much does the bench cost, and can it cost less?
 *
 * The strategy contract has no index parameter. A module is handed every bar
 * that has closed and asked what it thinks, with no way to say "the value at
 * bar 400". That is deliberate and it is the reason a future leak is not
 * expressible in this codebase rather than merely discouraged — and it has a
 * price, which is that a backtest over N bars is O(N²) with a large constant,
 * because each of the N calls rebuilds and rescans the whole prefix.
 *
 * Measured on `donchian-20` over hourly bars:

 *     1 000 bars      126 ms    0.126 ms per bar
 *     2 000 bars      560 ms    0.280 ms per bar
 *     4 000 bars    1 762 ms    0.440 ms per bar
 *     8 000 bars    8 131 ms    1.016 ms per bar

 * The time per bar roughly doubles whenever the series doubles. That is the
 * whole shape of it, and it extrapolates: 50 286 hourly bars is about 5½
 * minutes for one strategy, and a command that sweeps nine channel lengths
 * across eight folds is seventy times that.
 *
 * **The quadratic part cannot be removed, and the reason is the feature.** Making
 * it linear means giving a module an index or a window, and either one lets it
 * ask for a value at a bar that is not the last one — which is precisely the
 * hole the current shape closes. Speeding this up by making leaks expressible
 * would be paying for it with the only thing this project actually sells.
 *
 * One saving was available and it turned out to be worth almost nothing, which
 * is more interesting than the saving. `fromModule` used to call the module on
 * every bar, including the 900 it had already declared it was not ready for.
 * Skipping those is exact rather than approximate, and it removed 45% of the
 * calls and **4% of the time**. Cost is concentrated almost entirely in the
 * last bars, where the visible history is longest — so the calls that were
 * being skipped were the cheap ones. The bench was never slow because it asked
 * too many questions. It is slow because each question is expensive, and that
 * is the contract.
 *
 * The rest of this file exists so that nobody has to guess the cost of a run
 * again. See `bench-cost.cli.ts`.
 */

import { readFileSync } from 'node:fs';

import type { Candle } from '../types/market.js';

export interface Timing {
    readonly bars: number;
    readonly ms: number;
    readonly msPerBar: number;
}

/** Runs a timed job and reports it. Present so the measurement is a value, not a log line. */
export function timeRun(bars: number, run: () => void): Timing {
    const started = performance.now();
    run();
    const ms = performance.now() - started;

    return { bars, ms, msPerBar: ms / bars };
}

/**
 * The ratio of work per bar between a longer run and a shorter one.
 *
 * This is the number that identifies the complexity: 1 means linear, 2 means
 * quadratic. A timing table is read by eye and a doubling can hide inside the
 * noise of one row; a ratio between two runs cannot.
 */
export function growthRatio(shorter: Timing, longer: Timing): number {
    return longer.msPerBar / shorter.msPerBar;
}

/** Cost of a run predicted from one measured run, assuming the measured law. */
export function extrapolate(from: Timing, toBars: number, power: number): number {
    return (from.ms * (toBars / from.bars) ** power) / 1000;
}

export function loadHourly(file: string): Candle[] {
    return readFileSync(
        new URL(`../backtest/fixtures/${file}`, import.meta.url),
        'utf8',
    )
        .split(/\r?\n/u)
        .filter((line) => line.trim() !== '')
        .slice(1)
        .map((line) => {
            const [t, o, h, lo, cl, v] = line.split(',');

            return {
                timestamp: Number(t),
                open: Number(o),
                high: Number(h),
                low: Number(lo),
                close: Number(cl),
                volume: Number(v),
            };
        });
}
