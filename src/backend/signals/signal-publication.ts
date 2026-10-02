import { currentRegistry } from '../observability/registry.js';

import type { IndicatorSignal } from './signal.types.js';

/**
 * What the system is publishing, and how often that publication is news.
 *
 * `signal_generation_total` counts every signal handed to a caller, HOLD
 * included — a HOLD is an answer, and a counter that skipped it would say the
 * system had stopped working exactly when it had correctly decided to do
 * nothing. `signal_changes_total` counts only the publications that differ from
 * the one before, which is the number worth alerting on: a system that answers
 * a thousand times and changes twice is a system that has stopped noticing the
 * market, and the generation counter alone would show a healthy thousand.
 *
 * The "before" is process memory, not a database read. This is a rate over a
 * short window, and a query per analysis to learn what the previous analysis
 * said would be a round trip on the hot path of every page load to answer a
 * question the poller already knows. The first signal after a restart therefore
 * counts as a change, because with no memory of the previous one nothing
 * supports the other answer.
 *
 * The total is published **unlabelled**. The first version carried a
 * `from`/`to` label on it, which is the breakdown somebody wants when a flip
 * looks wrong — and the reason `signal_changes_total` was null to every reader
 * who asked for it by name, because the series that existed was
 * `signal_changes_total{from="LONG",to="SHORT"}` and not the metric that was
 * promised. A counter behind a label needs `sum by ()` on the far side, which
 * is the kind of thing that gets forgotten once and then reads as zero forever.
 * The direction pair is in the structured log, which is where a named event
 * belongs anyway.
 *
 * **The memory of the previous signal is per market, and the totals stay whole.**
 *
 * One variable for the whole process meant BTCUSDT publishing LONG and then
 * ETHUSDT publishing SHORT counted as a change — while **neither** market changed.
 * The counter that exists to answer "how often does this market revise itself"
 * answered "how often do two markets disagree", which is a number about the
 * deployment and not about any series.
 *
 * The counters are deliberately still unlabelled. Per-market series were the
 * obvious fix and the wrong one: a reader asking for `signal_changes_total` by
 * name would again get null, for the same reason as before, and `churnRate()`
 * would have to know which series to divide. The per-market difference is in the
 * memory, not in the exposition — and the markets are in the structured log the
 * numbers are derived from.
 */
const lastPublished = new Map<string, IndicatorSignal>();

export function recordPublishedSignal(
    direction: IndicatorSignal,
    market: string = '',
): void {
    const registry = currentRegistry();

    registry.counter('signal_generation_total');
    registry.counter('signal_generation_total', 0, { signal: direction });

    // Normalised, because the same market arriving as `btcusdt` and `BTCUSDT` is
    // the same series and two entries would each believe they were the first
    // publication of a market nobody had seen.
    const key = market.trim().toUpperCase();
    const previous = lastPublished.get(key);

    if (previous !== undefined && previous !== direction) {
        registry.counter('signal_changes_total');
    }

    lastPublished.set(key, direction);
}

export function lastPublishedSignal(market: string = ''): IndicatorSignal | null {
    return lastPublished.get(market.trim().toUpperCase()) ?? null;
}

/** Test hook: a run's first signal is a change again, as it is after a restart. */
export function resetPublishedSignals(): void {
    lastPublished.clear();
}

/**
 * The share of publications that were news.
 *
 * Reported as a number rather than left for a dashboard to divide, because the
 * ratio is the only form in which "a thousand answers, two changes" is visible
 * at all, and a division of two counters by hand is exactly the place where a
 * zero denominator quietly becomes a NaN on somebody's graph.
 */
export function churnRate(): number | null {
    const registry = currentRegistry();
    const generated = registry.value('signal_generation_total') ?? 0;
    const changed = registry.value('signal_changes_total') ?? 0;

    if (generated === 0) {
        return null;
    }

    return changed / generated;
}
