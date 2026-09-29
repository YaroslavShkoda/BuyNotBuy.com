/**
 * PHASE 14. What kind of market is this, decided from the data rather than typed.
 *
 * **This is not self-learning, and the difference is not a matter of degree.**
 * The rule in this project is that nothing changes itself on its way to
 * production, and "learned" would be the most dangerous word available if it
 * were left to mean what it usually means. So: a fixed rule, a stated
 * threshold, a recorded verdict, and no way for a verdict to change a decision
 * by itself. The classifier produces a row with `source = 'learned'` and the
 * caller still has to be willing to use it — which is the same position
 * `Source → Outcome → Statistics → Candidate → Backtest → Walk-forward →
 * Shadow → Approval → Production` takes about a strategy.
 *
 * **The rule is the trading week.** A cryptocurrency market trades every day of
 * the week. A market priced in a national currency has a weekend, and no bars
 * exist for it. That is observable in a candle series, it needs no model, and
 * it is checkable after the fact by anyone with the data.
 *
 * The alternative rules were considered and rejected as less honest:
 *
 * - *Volatility.* Crypto is more volatile than a currency pair, which is true on
 *   average and useless on one asset, where the overlap is total. A threshold
 *   would be fitted to the data it is applied to.
 * - *Decimals in the price.* Tells you about the instrument's scale, not about
 *   what it is.
 * - *Whether it moved today.* A holiday in one country is indistinguishable
 *   from a weekend, and the classifier would report "fiat" about a crypto
 *   market twice a year.
 *
 * **And it cannot yet be validated, which is stated here rather than left for
 * someone to discover.** This repository has candles for one market. A
 * classifier for telling crypto apart from fiat cannot be measured on a
 * corpus of one asset where every market is crypto. So what exists is the rule,
 * its tests, and a refusal to answer when the evidence is thin — and the
 * honest label on the whole thing is *untested against real multi-market data*,
 * not *working*. The first thing to do when a second market exists is measure
 * this, and the measurement will probably change the threshold.
 */

/** A candle reduced to the only field this rule looks at. */
export interface Observation {
    readonly timestamp: number;
}

const DAY_MS = 86_400_000;

/**
 * How much history before the classifier is willing to answer.
 *
 * Not "some data" — a number, and the reasoning: one full weekend has to be
 * *inside* the window, not merely near it, or the classifier is reporting that
 * a gap has not happened yet. Fourteen days covers two of them, which means one
 * unusually thin holiday cannot decide the answer by itself.
 */
export const MINIMUM_WINDOW_MS = 14 * DAY_MS;

export type Classification =
    | {
          readonly verdict: 'crypto';
          readonly confidence: 'observed';
          readonly evidence: Evidence;
      }
    | {
          readonly verdict: 'fiat';
          readonly confidence: 'observed';
          readonly evidence: Evidence;
      }
    | {
          readonly verdict: 'unknown';
          /**
           * The reason no verdict was reached. Two different situations — too
           * little data, and a series too short to contain a weekend — and they
           * are both fixed by the same person, so they are one answer rather
           * than two silences.
           *
           * There is deliberately no "this data is stale" answer here. A market
           * that is shut for the weekend has no bars for two days, and a
           * classifier that read that as a broken feed would report every fiat
           * market as suspect one day in seven. Feed freshness is a real
           * invariant with a real home — `history/ingestion.service.ts` and the
           * health registry both check it, and a second cruder copy inside this
           * function is how two answers about the same thing drift apart. That
           * is not hypothetical: it is the Binance provider bug fixed an hour
           * ago, where two methods of one class disagreed about which market
           * they were asking about.
           */
          readonly reason: 'too_little_history';
          readonly evidence: Evidence;
      };

export interface Evidence {
    /** Distinct UTC days seen, out of the days the window covers. */
    readonly daysSeen: number;
    readonly daysExpected: number;
    readonly weekendDaysSeen: number;
    readonly weekendDaysExpected: number;
    readonly firstBarAt: number;
    readonly lastBarAt: number;
    readonly bars: number;
}

const DAY_OF_WEEK = (timestamp: number): number =>
    Math.floor(timestamp / DAY_MS + 4) % 7;

/** Saturday and Sunday in UTC. */
const isWeekend = (dayOfWeek: number): boolean => dayOfWeek === 0 || dayOfWeek === 6;

/**
 * Decides what kind of market a candle series describes.
 *
 * Pure, and pure on purpose: a classifier that could not be tested without a
 * database would have its tests prove something about the connection rather
 * than about the rule.
 */
export function classifyByTradingWeek(
    candles: readonly Observation[],
    now: number,
): Classification {
    if (candles.length === 0) {
        return {
            verdict: 'unknown',
            reason: 'too_little_history',
            evidence: {
                daysSeen: 0,
                daysExpected: 0,
                weekendDaysSeen: 0,
                weekendDaysExpected: 0,
                firstBarAt: 0,
                lastBarAt: 0,
                bars: 0,
            },
        };
    }

    const timestamps = candles.map((candle) => candle.timestamp).sort((a, b) => a - b);
    const firstBarAt = timestamps[0]!;
    const lastBarAt = timestamps[timestamps.length - 1]!;
    const days = new Set(timestamps.map((timestamp) => Math.floor(timestamp / DAY_MS)));

    const daysExpected = Math.max(
        1,
        Math.floor((lastBarAt - firstBarAt) / DAY_MS) + 1,
    );
    // Weekend days counted **inside the window**, not across the whole series.
    // Counting them across all history while counting the expected ones only in
    // the recent window compares two different periods, and does it in the
    // direction that always finds evidence: a market that traded at 3am on a
    // Sunday three months ago would be called 24/7 forever, even if it has been
    // shut since.
    const windowStart = Math.max(firstBarAt, now - MINIMUM_WINDOW_MS);
    const weekendDaysInWindow = new Set(
        timestamps
            .filter((timestamp) => timestamp >= windowStart)
            .filter((timestamp) => isWeekend(DAY_OF_WEEK(timestamp)))
            .map((timestamp) => Math.floor(timestamp / DAY_MS)),
    );
    const weekendDaysExpected = Math.max(
        0,
        Math.floor((lastBarAt - windowStart) / DAY_MS),
    );

    const evidence: Evidence = {
        daysSeen: days.size,
        daysExpected,
        weekendDaysSeen: weekendDaysInWindow.size,
        weekendDaysExpected,
        firstBarAt,
        lastBarAt,
        bars: candles.length,
    };

    // Thin data first, and before anything else is interpreted. A market with
    // three days of history has not been shown to have a weekend; it has not
    // yet been observed long enough to have one.
    if (lastBarAt - firstBarAt < MINIMUM_WINDOW_MS) {
        return { verdict: 'unknown', reason: 'too_little_history', evidence };
    }

    // A week with at least one full weekend in it, counted inside the recent
    // window rather than anywhere in the history.
    if (weekendDaysExpected < 2) {
        return { verdict: 'unknown', reason: 'too_little_history', evidence };
    }

    if (weekendDaysInWindow.size > 0) {
        return { verdict: 'crypto', confidence: 'observed', evidence };
    }

    // Every expected weekend inside the window is empty. That is the shape of a
    // market with a trading week.
    return { verdict: 'fiat', confidence: 'observed', evidence };
}

/**
 * A sentence for the row.
 *
 * Written to be stored next to the verdict, so that a classification can be
 * argued with later by reading why it was made rather than by re-running the
 * code that made it against data that has since changed.
 */
export function describeClassification(classification: Classification): string {
    const { evidence } = classification;

    if (classification.verdict === 'unknown') {
        return (
            `не определено (${classification.reason}): ` +
            `${evidence.bars} баров за ${evidence.daysSeen} дн., ` +
            `выходных с барами ${evidence.weekendDaysSeen} из ${evidence.weekendDaysExpected}`
        );
    }

    return (
        `${classification.verdict}: ${evidence.bars} баров за ${evidence.daysSeen} дн., ` +
        `выходных с барами ${evidence.weekendDaysSeen} из ${evidence.weekendDaysExpected}`
    );
}
