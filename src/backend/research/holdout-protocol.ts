/**
 * What is being asked of the held-out window, decided before it exists.
 *
 * `holdout.ts` says the honest thing: the window is read once, and nothing in
 * the code can enforce that, because reading a number does not record that it
 * was read. That is true and it is also the end of the useful thinking, and
 * the reasoning stops there too early.
 *
 * Nobody can be stopped from loading a CSV twice. The bars are in the
 * repository; a curious person is going to look at them, and no amount of
 * ceremony in a TypeScript module changes that. Any design that promises to
 * protect the *data* is promising something it cannot deliver.
 *
 * What can be protected is the *question*. The failure mode this is actually
 * afraid of is not someone re-reading the window — it is someone reading it,
 * finding that the return was ugly, and then deciding which statistic to
 * report. Return looked bad? Report the profit factor. Too few trades? Report
 * the hit rate on the trades that were taken. The number was not the
 * problem; the fact that it was chosen afterwards is.
 *
 * So the binding is moved upstream, to where it is still cheap:
 *
 *   1. The metrics are a **closed set**. `METRIC_KEYS` is the whole list, and
 *      it is not extensible at runtime. There is no way to invent a statistic
 *      after the window fills, because there is no way to invent one at all.
 *   2. The protocol is **fingerprinted when registered**, while the window is
 *      still empty. A later change to the metric list changes the fingerprint
 *      and is visible as a change, the same way a changed strategy is.
 *   3. The verdict is **complete**. Every declared metric for every registered
 *      rule goes into the record — not the ones that came out well. Selecting
 *      a subset of your own output is the one move this makes impossible,
 *      because the subset is fixed before anyone has seen a bar.
 *
 * What this does not do, stated plainly so nobody has to find out later: it
 * does not stop the bars being re-read, and it does not stop someone writing
 * a new module with a different purpose. It makes a quiet reshuffle of the
 * question require editing a closed list, and it stores the whole answer so
 * that a reshuffle would be visible next to the one it replaced.
 *
 * That is strictly more than a comment and a date. It is not a lock.
 */

import { calculateMetrics } from '../backtest/metrics.js';
import { runStrategy } from './strategies.js';

import type { BacktestMetrics } from '../backtest/metrics.js';
import type { Strategy } from './strategies.js';
import type { Candle } from '../types/market.js';

/**
 * Every statistic that may ever be reported about the window.
 *
 * A closed union, deliberately. An open one — a list anyone could extend with
 * a new metric once a number came out badly — would be a formality. This is
 * the list, and adding to it is a visible act rather than an option at the
 * moment of reporting.
 */
export const METRIC_KEYS = [
    'totalReturn',
    'profitFactor',
    'trades',
    'winRate',
    'maxDrawdown',
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export interface HoldoutProtocol {
    /** Which statistics will be reported. Decided before the window fills. */
    readonly metrics: readonly MetricKey[];
    readonly registeredAt: number;
    readonly note: string;
}

export type MetricReadings = Readonly<Record<MetricKey, number | null>>;

/**
 * The one line of the protocol that gets stored and compared.
 *
 * Order is normalised, because a protocol that says `return, trades` and one
 * that says `trades, return` are the same question asked the same way, and a
 * fingerprint that moved for a reordering would cry wolf.
 */
export function protocolFingerprint(protocol: HoldoutProtocol): string {
    const metrics = [...protocol.metrics].sort().join(',');

    return `metrics=${metrics};note=${protocol.note.trim()}`;
}

export function readMetrics(metrics: BacktestMetrics): MetricReadings {
    return {
        totalReturn: metrics.totalReturn,
        profitFactor: metrics.profitFactor,
        trades: metrics.trades,
        winRate: metrics.winRate,
        maxDrawdown: metrics.maxDrawdown,
    };
}

export interface Verdict {
    readonly key: string;
    /** Every declared metric. There is no way to return a subset. */
    readonly readings: MetricReadings;
}

/**
 * Runs every registered rule and reports every declared metric.
 *
 * There is no argument for which metrics to return and no option to report
 * only the good ones — the caller does not get to choose, which is the entire
 * point. A function with a `metrics: MetricKey[]` parameter would be the same
 * function with the guard removed, and someone would eventually pass one key.
 */
export function evaluateProtocol(
    protocol: HoldoutProtocol,
    rules: ReadonlyArray<{ readonly key: string; readonly strategy: Strategy }>,
    candles: readonly Candle[],
): readonly Verdict[] {
    return rules.map(({ key, strategy }) => {
        const result = runStrategy(strategy, candles, { barsPerYear: 365 });
        const all = readMetrics(result.metrics);

        // Projected, not filtered. The stored record is the protocol's whole
        // output; a caller reading it can look at as much or as little as they
        // like, but cannot come back for the rest of it.
        return {
            key,
            readings: Object.fromEntries(
                protocol.metrics.map((metric) => [metric, all[metric]]),
            ) as MetricReadings,
        };
    });
}

/** Names a rule whose protocol no longer matches the one registered. */
export function protocolChanged(
    registered: HoldoutProtocol,
    current: HoldoutProtocol,
): boolean {
    return protocolFingerprint(registered) !== protocolFingerprint(current);
}

/** True when the protocol asks for something outside the closed set. */
export function isKnownMetric(metric: string): metric is MetricKey {
    return (METRIC_KEYS as readonly string[]).includes(metric);
}

export { calculateMetrics };
