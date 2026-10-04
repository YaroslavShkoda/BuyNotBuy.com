import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SignalOutcome } from '../outcomes/outcome.js';
import {
    type HorizonSelector,
    type OutcomeWithPublication,
    type PublishedSignal,
    resolveAtHorizon,
    toPerformanceSamples,
    windowClosed,
} from './samples.js';

const HOUR = 3_600_000;

/** An outcome whose window at `bars` closed at `entry + bars * HOUR`. */
function outcomeAt(
    entryTimestamp: number,
    bars: number,
    overrides: Partial<SignalOutcome['horizons'][number]> = {},
    direction: 'LONG' | 'SHORT' = 'LONG',
): SignalOutcome {
    return {
        symbol: 'BTCUSDT',
        entryTimestamp,
        entryPrice: 100,
        direction,
        horizons: [
            {
                bars,
                returnFraction: 0.01,
                maxFavourable: 0.02,
                maxAdverse: -0.01,
                verdict: 'correct',
                ...overrides,
            },
        ],
        closedBy: null,
    };
}

const selector = (asOf: number, bars = 8, graceMs = 0): HorizonSelector => ({
    bars,
    asOf,
    graceMs,
});

const published = (confidence: number): PublishedSignal => ({ confidence });

describe('whether a window has closed', () => {
    it('is closed once the last bar is in', () => {
        expect(
            windowClosed(outcomeAt(1_000_000, 8), selector(1_000_000 + 8 * HOUR)),
        ).toBe(true);
    });

    it('is open one millisecond before that', () => {
        expect(
            windowClosed(outcomeAt(1_000_000, 8), selector(1_000_000 + 8 * HOUR - 1)),
        ).toBe(false);
    });

    it('waits out the grace period before calling a window closed', () => {
        // A market that has not published the closing bar yet has not finished
        // the window. Grace *delays* the moment the window counts as closed, so
        // the moment to test is the one between the bar and the grace expiring —
        // my first version of this test asked a minute after the window ended
        // and expected it to be open, which it is not, correctly.
        const at = 1_000_000 + 8 * HOUR + 60_000;

        expect(windowClosed(outcomeAt(1_000_000, 8), selector(at, 8, 0))).toBe(true);
        expect(windowClosed(outcomeAt(1_000_000, 8), selector(at, 8, 5 * 60_000))).toBe(false);
        expect(windowClosed(outcomeAt(1_000_000, 8), selector(at, 8, 30_000))).toBe(true);
    });

    it('refuses a negative grace rather than accepting an impossible window', () => {
        // Not defensive coding: a negative grace makes the window close before
        // its own last bar, which is a question with a silly answer, and the
        // right answer is to say so at the boundary.
        expect(() => windowClosed(outcomeAt(1_000_000, 8), selector(9_999_999, 8, -1))).toThrow(
            /graceMs/,
        );
    });
});

describe('resolving one outcome at a named horizon', () => {
    it('measures a resolved window that has closed', () => {
        const resolved = resolveAtHorizon(
            outcomeAt(1_000_000, 8),
            selector(1_000_000 + 8 * HOUR),
        );

        expect(resolved.usable).toBe(true);
        expect(resolved.outcome.verdict).toBe('correct');
    });

    it('refuses a signal that has not resolved', () => {
        const resolved = resolveAtHorizon(
            outcomeAt(1_000_000, 8, { verdict: 'unknown', returnFraction: null }),
            selector(1_000_000 + 8 * HOUR),
        );

        expect(resolved.usable).toBe(false);
        expect(resolved.reason).toBe('unresolved');
    });

    it('refuses an expired window and keeps that reason separate', () => {
        // A signal that ran out of bars is a property of the sample, not of the
        // moment. Averaged in, it hides inside every other number.
        const resolved = resolveAtHorizon(
            outcomeAt(1_000_000, 8, { verdict: 'expired' }),
            selector(1_000_000 + 8 * HOUR),
        );

        expect(resolved.usable).toBe(false);
        expect(resolved.reason).toBe('expired');
    });

    it('refuses a resolved verdict whose window has not closed yet', () => {
        // The leak this file exists to stop. The outcome says `correct`, the
        // verdict is a real measurement — and the bar that produced it is in
        // the future. Taken, the table is not wrong in any visible way.
        const resolved = resolveAtHorizon(
            outcomeAt(1_000_000, 8),
            selector(1_000_000 + 8 * HOUR - 1),
        );

        expect(resolved.usable).toBe(false);
        expect(resolved.reason).toBe('unresolved');
    });

    it('refuses to measure a horizon nobody ran', () => {
        // A named default would be a default nobody chose, and the table would
        // be a report of an experiment that did not happen.
        expect(() => resolveAtHorizon(outcomeAt(1_000_000, 8), selector(9_999_999, 24))).toThrow(
            /no horizon of 24 bars/,
        );
    });
});

describe('turning outcomes into samples', () => {
    const pairs = (...entries: OutcomeWithPublication[]): OutcomeWithPublication[] => entries;

    it('carries the published confidence, not one read off the outcome', () => {
        // The outcome knows what the market did. It does not know what the
        // system claimed, and a confidence reconstructed here would be the
        // answer to a question that was not asked at the time.
        const report = toPerformanceSamples(
            pairs({
                outcome: outcomeAt(1_000_000, 8),
                published: published(72),
            }),
            selector(1_000_000 + 8 * HOUR),
        );

        expect(report.samples[0]?.confidence).toBe(72);
    });

    it('carries a confidence of zero without treating it as absent', () => {
        const report = toPerformanceSamples(
            pairs({
                outcome: outcomeAt(1_000_000, 8),
                published: published(0),
            }),
            selector(1_000_000 + 8 * HOUR),
        );

        expect(report.samples[0]?.confidence).toBe(0);
    });

    it('omits a regime that was not recorded rather than recording none', () => {
        // `exactOptionalPropertyTypes` is on for the same reason: a sample with
        // `regime: undefined` reads as a measurement of "no regime", which is a
        // claim, and the claim is not supported.
        const report = toPerformanceSamples(
            pairs({ outcome: outcomeAt(1_000_000, 8), published: published(60) }),
            selector(1_000_000 + 8 * HOUR),
        );

        expect('regime' in (report.samples[0] as object)).toBe(false);
    });

    it('counts what it left out and why', () => {
        // The dangerous shape is a table that drops half its rows and reports
        // the rest as "the performance" — every number in it is true.
        const report = toPerformanceSamples(
            pairs(
                { outcome: outcomeAt(1_000_000, 8), published: published(70) },
                {
                    outcome: outcomeAt(2_000_000, 8, { verdict: 'unknown' }),
                    published: published(60),
                },
                {
                    outcome: outcomeAt(3_000_000, 8, { verdict: 'expired' }),
                    published: published(50),
                },
                { outcome: outcomeAt(4_000_000, 24), published: published(40) },
            ),
            selector(200_000_000, 8),
        );

        expect(report.measured).toBe(1);
        expect(report.excluded).toEqual({
            total: 3,
            unresolved: 1,
            expired: 1,
            otherHorizon: 1,
        });
    });

    it('produces nothing rather than something empty and confident', () => {
        const report = toPerformanceSamples([], selector(9_999_999, 8));

        expect(report.measured).toBe(0);
        expect(report.samples).toEqual([]);
    });

    it('measures a short in its own direction without special-casing', () => {
        const report = toPerformanceSamples(
            pairs({
                outcome: outcomeAt(1_000_000, 8, { verdict: 'incorrect' }, 'SHORT'),
                published: published(65),
            }),
            selector(1_000_000 + 8 * HOUR),
        );

        expect(report.samples[0]?.direction).toBe('SHORT');
        expect(report.samples[0]?.verdict).toBe('incorrect');
    });
});

describe('properties', () => {
    const entry = fc.integer({ min: 0, max: 1_000_000_000 });
    const bars = fc.constantFrom(1, 4, 8, 24);

    it('never measures a window that had not closed at the moment asked', () => {
        // The invariant, over horizons and moments nobody enumerated: no sample
        // in a report may rest on a bar from after `asOf`.
        fc.assert(
            fc.property(entry, bars, fc.integer({ min: -3_600_000, max: 40 * 3_600_000 }), (at, window, offset) => {
                const asOf = at + offset;
                const report = toPerformanceSamples(
                    [{ outcome: outcomeAt(at, window), published: published(50) }],
                    selector(asOf, window),
                );

                if (report.measured === 0) {
                    return true;
                }

                return at + window * HOUR <= asOf;
            }),
            { numRuns: 300 },
        );
    });

    it('accounts for every signal it was given, in one bucket or another', () => {
        // A table that neither measures nor accounts for a signal has dropped
        // it, and a dropped signal is indistinguishable from a good one.
        fc.assert(
            fc.property(
                fc.array(fc.tuple(entry, bars, fc.constantFrom('correct', 'unknown', 'expired')), {
                    minLength: 0,
                    maxLength: 8,
                }),
                entry,
                bars,
                (entries, asOf, window) => {
                    const report = toPerformanceSamples(
                        entries.map(([at, w, verdict]) => ({
                            outcome: outcomeAt(at, w, { verdict } as never),
                            published: published(50),
                        })),
                        selector(asOf, window),
                    );

                    return report.measured + report.excluded.total === entries.length;
                },
            ),
            { numRuns: 200 },
        );
    });

    it('never turns a zero confidence into a missing sample', () => {
        fc.assert(
            fc.property(fc.integer({ min: 0, max: 100 }), (confidence) => {
                const report = toPerformanceSamples(
                    [{ outcome: outcomeAt(1_000_000, 8), published: published(confidence) }],
                    selector(1_000_000 + 8 * HOUR, 8),
                );

                return report.measured === 1 && report.samples[0]?.confidence === confidence;
            }),
            { numRuns: 100 },
        );
    });
});
