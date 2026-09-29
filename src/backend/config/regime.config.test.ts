import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import {
    barsPerDay,
    regimeConfig,
    regimeWindowFor,
} from './regime.config.js';

/**
 * The regime window is a length in time, and the code said 720 bars.
 *
 * The configuration's own comment explains why a boundary is a claim about what
 * is normal *for this instrument* — and then the boundary is a multiple of the
 * instrument's own median, so it needs no instrument of its own. What does need
 * one is the window: 720 bars is 30 days on an hourly chart and 12 hours on a
 * minute one, so the number the configuration stated an intent for was not the
 * number any other timeframe was computing.
 *
 * These tests pin both halves of that: that the shorter timeframes now get a
 * window of the right length, and that the hourly one is unchanged to the bar.
 * The second matters more. A change that quietly widened the one-hour baseline
 * would re-label every regime the system has ever stored, and the rule is that
 * old results are never rewritten.
 */
afterEach(() => {
    vi.unstubAllEnvs();
});

describe('bars in a day', () => {
    it('knows how long a day is on each timeframe', () => {
        expect(barsPerDay('1m')).toBe(1_440);
        expect(barsPerDay('5m')).toBe(288);
        expect(barsPerDay('15m')).toBe(96);
        expect(barsPerDay('1h')).toBe(24);
        expect(barsPerDay('4h')).toBe(6);
        expect(barsPerDay('1d')).toBe(1);
    });

    it('does not care how the timeframe is written', () => {
        // The interval reaches this function from configuration, from a URL and
        // from whatever the exchange echoed back. A reader that matched one
        // spelling would measure a minute chart as an hourly one.
        expect(barsPerDay('1H')).toBe(24);
        expect(barsPerDay(' 1h ')).toBe(24);
        expect(barsPerDay('1D')).toBe(1);
    });

    it('asks for hourly when the timeframe is not known', () => {
        // Every stored reading was computed on the hourly reading of these
        // numbers. Guessing a timeframe from the length of a series would
        // relabel history, and a rule that may not change what has already been
        // measured is worth more here than completeness.
        expect(barsPerDay(undefined)).toBe(24);
        expect(barsPerDay('three hours')).toBe(24);
        expect(barsPerDay('')).toBe(24);
    });

    it('always returns a positive whole number of bars', () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 8 }), (interval) => {
                const bars = barsPerDay(interval);

                return Number.isInteger(bars) && bars > 0;
            }),
            { numRuns: 200 },
        );
    });
});

describe('the window a regime is measured over', () => {
    it('is exactly what the shipped configuration asked for on an hourly chart', () => {
        // The pin that matters most: not "close to", not "at least" — the same
        // two numbers, so that nothing already stored changes.
        expect(regimeWindowFor('1h')).toEqual({
            baselineBars: regimeConfig.baselineBars,
            minimumBars: regimeConfig.minimumBars,
        });
        expect(regimeWindowFor('1h').baselineBars).toBe(720);
        expect(regimeWindowFor('1h').minimumBars).toBe(50);
    });

    it('stretches the baseline to the same span of time on a finer chart', () => {
        // 30 days is 43 200 minutes and 720 hours. Reading 720 minutes would
        // call a twelve-hour stretch a month, and every quiet stretch in it
        // would look like a collapse in volatility.
        expect(regimeWindowFor('1m').baselineBars).toBe(43_200);
        expect(regimeWindowFor('5m').baselineBars).toBe(8_640);
        expect(regimeWindowFor('15m').baselineBars).toBe(2_880);
    });

    it('covers the same span on a coarser chart rather than running shorter', () => {
        // Two years of daily bars is still a baseline, and the shipped 720 is
        // kept underneath: shrinking the window would start calling quiet
        // markets ordinary on less evidence than before, under the same label.
        expect(regimeWindowFor('1d').baselineBars).toBe(720);
        expect(regimeWindowFor('4h').baselineBars).toBe(720);
    });

    it('keeps the shipped minimum under every timeframe it derives', () => {
        // `Math.max`, not a replacement: the shipped numbers are the values the
        // configuration was tuned against, and a derived one that came out
        // below them would make the system stricter than the setting says.
        for (const interval of ['1m', '5m', '15m', '1h', '4h', '1d']) {
            expect(regimeWindowFor(interval).baselineBars).toBeGreaterThanOrEqual(
                regimeConfig.baselineBars,
            );
            expect(regimeWindowFor(interval).minimumBars).toBeGreaterThanOrEqual(
                regimeConfig.minimumBars,
            );
        }
    });

    it('spans a comparable amount of time on every timeframe', () => {
        // The property behind the change: whatever the chart, the baseline
        // covers at least the thirty days the configuration asked for. A regime
        // measured over a tenth of that is a different measurement wearing the
        // same name.
        fc.assert(
            fc.property(
                fc.constantFrom('1m', '5m', '15m', '1h', '4h', '1d'),
                (interval) => {
                    const days = regimeWindowFor(interval).baselineBars / barsPerDay(interval);

                    return days >= regimeConfig.baselineDays;
                },
            ),
            { numRuns: 60 },
        );
    });

    it('never returns a minimum above the baseline it is paired with', () => {
        // The configuration's own refinement, re-checked on the derived numbers
        // for every timeframe — a window pair that cannot both be satisfied is
        // one where nothing is ever measured.
        fc.assert(
            fc.property(fc.constantFrom('1m', '5m', '15m', '1h', '4h', '1d'), (interval) => {
                const window = regimeWindowFor(interval);

                return window.minimumBars <= window.baselineBars;
            }),
            { numRuns: 60 },
        );
    });
});
