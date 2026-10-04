import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
    classifyByTradingWeek,
    describeClassification,
    MINIMUM_WINDOW_MS,
} from './classify.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** 2024-01-01T00:00:00Z, a Monday, so weekend counting is easy to reason about. */
const MONDAY = Date.UTC(2024, 0, 1);

/** Bars for every hour of every day, the way a 24/7 market behaves. */
const alwaysTrading = (from: number, days: number): { timestamp: number }[] => {
    const bars: { timestamp: number }[] = [];

    for (let hour = 0; hour < days * 24; hour += 1) {
        bars.push({ timestamp: from + hour * HOUR });
    }

    return bars;
};

/** Bars for the same span, minus every Saturday and Sunday. */
const weekdaysOnly = (from: number, days: number): { timestamp: number }[] =>
    alwaysTrading(from, days).filter((bar) => {
        const dayOfWeek = Math.floor(bar.timestamp / DAY + 4) % 7;

        return dayOfWeek !== 0 && dayOfWeek !== 6;
    });

describe('classifyByTradingWeek', () => {
    it('calls a market that trades at 3am on Sunday a crypto market', () => {
        const bars = alwaysTrading(MONDAY, 21);
        const result = classifyByTradingWeek(bars, MONDAY + 21 * DAY);

        expect(result.verdict).toBe('crypto');
    });

    it('calls a market with no weekend bars a fiat market', () => {
        const bars = weekdaysOnly(MONDAY, 21);
        const result = classifyByTradingWeek(bars, MONDAY + 21 * DAY);

        expect(result.verdict).toBe('fiat');
    });

    it('refuses to answer from three days of history', () => {
        // The case the whole design turns on. A market with three days of bars
        // has not been shown to have a weekend; it has not been watched long
        // enough to have one, and "no weekend so far" is what a crypto market
        // looks like on a Wednesday.
        const result = classifyByTradingWeek(alwaysTrading(MONDAY, 3), MONDAY + 3 * DAY);

        expect(result).toMatchObject({ verdict: 'unknown', reason: 'too_little_history' });
    });

    it('refuses to answer from a single day', () => {
        expect(classifyByTradingWeek(alwaysTrading(MONDAY, 1), MONDAY + DAY).verdict).toBe(
            'unknown',
        );
    });

    it('refuses to answer from nothing at all', () => {
        const result = classifyByTradingWeek([], MONDAY);

        expect(result).toMatchObject({ verdict: 'unknown', reason: 'too_little_history' });
        expect(result.verdict === 'unknown' && result.evidence.bars).toBe(0);
    });

    it('does not judge whether the feed is alive, because a weekend is not a fault', () => {
        // The first version answered 'unknown' with a staleness reason whenever
        // the last bar was more than two days old, and a fiat market at the end
        // of a weekend is exactly that — so every fiat market came back suspect
        // one day in seven. The check was removed rather than tuned, because
        // freshness has a real home in the ingestion service and a second,
        // cruder copy is how two answers about the same thing drift apart.
        const bars = weekdaysOnly(MONDAY, 21);
        const staleByAnyClock = MONDAY + 21 * DAY;

        // Classified on its own shape, and the caller is the one who asks
        // whether the data is current.
        expect(classifyByTradingWeek(bars, staleByAnyClock).verdict).toBe('fiat');
        expect(classifyByTradingWeek(alwaysTrading(MONDAY, 21), staleByAnyClock).verdict).toBe(
            'crypto',
        );
    });

    it('flips on a single weekend bar inside the window, and that is a known weakness', () => {
        // Measured, not wished for. The rule is "any weekend bar in the recent
        // window means this market trades weekends", and one stray bar is
        // enough. Distinguishing a venue hiccup from a real Sunday session
        // needs a threshold, and a threshold fitted to the one market this
        // repository has data for would be a number with no evidence behind it.
        //
        // So the sensitivity is written down instead of tuned away. This is the
        // first thing to measure when a second market exists, and the
        // measurement will probably change the rule.
        const bars = [
            ...weekdaysOnly(MONDAY, 21),
            // Monday + 13 days is the Sunday inside the recent fortnight, and
            // +6 days is the Sunday three weeks ago. Getting this wrong is
            // silent — a "weekend" bar on a Tuesday is simply not a weekend bar.
            { timestamp: MONDAY + 13 * DAY + 12 * HOUR },
        ];

        expect(classifyByTradingWeek(bars, MONDAY + 21 * DAY).verdict).toBe('crypto');
    });

    it('ignores a stray weekend bar that is outside the window', () => {
        // The same stray bar, three weeks ago. The window is what makes the
        // difference, and a series that traded one Sunday in March has not
        // demonstrated that it trades Sundays now.
        const bars = [...weekdaysOnly(MONDAY, 21), { timestamp: MONDAY + 6 * DAY + 12 * HOUR }];

        expect(classifyByTradingWeek(bars, MONDAY + 21 * DAY).verdict).toBe('fiat');
    });

    it('does not need the bars to be in order', () => {
        const bars = alwaysTrading(MONDAY, 21).reverse();

        expect(classifyByTradingWeek(bars, MONDAY + 21 * DAY).verdict).toBe('crypto');
    });

    it('does not let a Sunday three months ago decide what trades today', () => {
        // Weekend bars counted across all history while expected weekends were
        // counted only in the recent window compares two different periods — and
        // does it in the direction that always finds evidence. A market that
        // traded at 3am one Sunday and has been shut since would have been
        // called 24/7 forever.
        const old = alwaysTrading(MONDAY, 30);
        const recent = weekdaysOnly(MONDAY + 40 * DAY, 10);
        const bars = [...old, ...recent];

        expect(classifyByTradingWeek(bars, MONDAY + 50 * DAY).verdict).toBe('fiat');
    });

    it('reports what it saw, so the verdict can be argued with later', () => {
        // Twenty-one days, of which the recent fourteen contain four weekend
        // days. Both numbers are the evidence: a reader who disagrees with the
        // verdict can see that four weekend days were present without having to
        // re-run anything.
        const bars = alwaysTrading(MONDAY, 21);
        const result = classifyByTradingWeek(bars, MONDAY + 21 * DAY);

        expect(result.evidence).toMatchObject({
            bars: 21 * 24,
            daysSeen: 21,
            weekendDaysSeen: 4,
        });
    });

    it('never answers crypto or fiat without enough history to have seen a weekend', () => {
        // The invariant, checked over generated spans rather than a list: a
        // verdict is only ever reached once the window is long enough that a
        // weekend could have appeared in it.
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 40 }), (days) => {
                const result = classifyByTradingWeek(
                    alwaysTrading(MONDAY, days),
                    MONDAY + days * DAY,
                );

                if (result.verdict !== 'unknown') {
                    expect(lastMinusFirst(days)).toBeGreaterThanOrEqual(MINIMUM_WINDOW_MS);
                }
            }),
            { numRuns: 40 },
        );
    });

    it('agrees with itself on the same input', () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 40 }), (days) => {
                const bars = alwaysTrading(MONDAY, days);
                const now = MONDAY + days * DAY;

                expect(classifyByTradingWeek(bars, now)).toEqual(
                    classifyByTradingWeek(bars, now),
                );
            }),
            { numRuns: 40 },
        );
    });
});

function lastMinusFirst(days: number): number {
    return Math.max(0, (days * 24 - 1) * HOUR);
}

describe('describeClassification', () => {
    it('says what it saw, and not just the answer', () => {
        const result = classifyByTradingWeek(alwaysTrading(MONDAY, 21), MONDAY + 21 * DAY);
        const text = describeClassification(result);

        // A classification stored without its evidence cannot be questioned
        // later except by re-running code against data that has since changed.
        expect(text).toContain('crypto');
        expect(text).toContain('504');
        expect(text).toContain('4');
    });

    it('says why it refused', () => {
        const thin = classifyByTradingWeek(alwaysTrading(MONDAY, 2), MONDAY + 2 * DAY);

        expect(describeClassification(thin)).toContain('too_little_history');
    });
});
