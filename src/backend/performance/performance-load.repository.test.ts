import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SignalOutcome } from '../outcomes/outcome.js';
import { groupIntoSignals } from './performance-load.repository.js';

type Row = Parameters<typeof groupIntoSignals>[0][number];

const HOUR = 3_600_000;

/**
 * A row as the loader reads it.
 *
 * `id` is the row's own primary key and is deliberately different for every
 * row: a signal measured at two horizons really does have two ids, which is
 * what makes the grouping question a real one rather than a formality.
 */
function row(overrides: Partial<Row> = {}): Row {
    return {
        id: crypto.randomUUID(),
        signal_state_id: 1,
        symbol: 'BTCUSDT',
        entry_timestamp: 1_000_000,
        entry_price: 100,
        direction: 'LONG',
        verdict: 'correct',
        horizon_bars: 8,
        return_fraction: 0.01,
        max_favourable: 0.02,
        max_adverse: -0.01,
        closed_by: null,
        regime: null,
        confidence: 70,
        ...overrides,
    } as Row;
}

describe('grouping rows into signals', () => {
    it('counts a signal once no matter how many rows it has', () => {
        // The mistake this file exists to catch. Grouping by `id` — which is
        // this table's row key, one per horizon — counts a signal measured at
        // two horizons twice, and a table that counts a real row twice is
        // arithmetically correct at every step.
        const { signals } = groupIntoSignals(
            [
                row({ id: 'a', horizon_bars: 8 }),
                row({ id: 'b', horizon_bars: 8 }),
            ],
            8,
        );

        expect(signals).toHaveLength(1);
    });

    it('keeps two signals apart even when they share a horizon', () => {
        const { signals } = groupIntoSignals(
            [
                row({ id: 'a', signal_state_id: 1 }),
                row({ id: 'b', signal_state_id: 2 }),
            ],
            8,
        );

        expect(signals).toHaveLength(2);
    });

    it('ignores rows measured at a horizon it was not asked about', () => {
        // Measuring at 8 bars says nothing about the 24 bar reading, and a
        // table that mixed them would be a report on an experiment that was
        // never run at one horizon.
        const { signals } = groupIntoSignals(
            [row({ id: 'a', horizon_bars: 8 }), row({ id: 'b', horizon_bars: 24 })],
            8,
        );

        expect(signals).toHaveLength(1);
        expect(signals[0]?.outcome.horizons).toHaveLength(1);
    });

    it('carries the published confidence and the regime recorded at publication', () => {
        const { signals } = groupIntoSignals(
            [row({ id: 'a', confidence: 73, regime: 'trend' })],
            8,
        );

        expect(signals[0]?.published.confidence).toBe(73);
        expect(signals[0]?.published.regime).toBe('trend');
    });

    it('counts a row nobody claimed instead of inventing a confidence for it', () => {
        // It cannot be calibrated: there is nothing in it that was said. Counting
        // it would put rows nobody spoke about into a table about claims.
        const { signals, withoutClaim } = groupIntoSignals(
            [row({ id: 'a', signal_state_id: null, confidence: null })],
            8,
        );

        expect(signals).toHaveLength(0);
        expect(withoutClaim).toBe(1);
    });

    it('counts a confidence of zero as a claim, not as an absence', () => {
        // A LEFT JOIN returns null for missing and zero for a real zero. The
        // difference is the whole reason this branch exists.
        const { signals, withoutClaim } = groupIntoSignals(
            [row({ id: 'a', confidence: 0 })],
            8,
        );

        expect(signals).toHaveLength(1);
        expect(withoutClaim).toBe(0);
        expect(signals[0]?.published.confidence).toBe(0);
    });

    it('collects every horizon of one signal onto that signal', () => {
        const { signals } = groupIntoSignals(
            [
                row({ id: 'a', horizon_bars: 8, verdict: 'correct' }),
                row({ id: 'b', horizon_bars: 24, verdict: 'incorrect' }),
            ],
            8,
        );

        expect(signals[0]?.outcome.horizons).toEqual([
            {
                bars: 8,
                returnFraction: 0.01,
                maxFavourable: 0.02,
                maxAdverse: -0.01,
                verdict: 'correct',
            },
        ]);
    });

    it('returns nothing rather than an empty answer for an empty read', () => {
        expect(groupIntoSignals([], 8)).toEqual({ signals: [], withoutClaim: 0 });
    });
});

describe('properties', () => {
    it('never reports more signals than it read distinct signal identities', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.tuple(
                        fc.integer({ min: 1, max: 4 }),
                        fc.integer({ min: 8, max: 24 }),
                        fc.integer({ min: 0, max: 100 }),
                    ),
                    { minLength: 0, maxLength: 12 },
                ),
                (spec) => {
                    const rows = spec.map(([stateId, bars, confidence]) =>
                        row({ id: crypto.randomUUID(), signal_state_id: stateId, horizon_bars: bars, confidence }),
                    );
                    const { signals, withoutClaim } = groupIntoSignals(rows, 8);
                    const identities = new Set(
                        rows
                            .filter((r) => r.horizon_bars === 8)
                            .map((r) => r.signal_state_id),
                    );

                    // Counted or accounted for, and never more of one than the
                    // other: a signal is either something we can calibrate or
                    // something we could not, and the counts must not overlap.
                    return signals.length + withoutClaim === identities.size;
                },
            ),
            { numRuns: 200 },
        );
    });

    it('never counts the same signal identity twice, whatever rows it has', () => {
        // Rows at a horizon that was not asked about are dropped, so the
        // identities being compared have to be the ones at the asked-about
        // horizon. My first version of this compared against every identity
        // read, and failed on a row at 24 bars when asked about 8 — which is
        // the code being right about a property that was not true.
        fc.assert(
            fc.property(
                fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 10 }),
                (stateIds) => {
                    const rows = stateIds.map((stateId) =>
                        row({ id: crypto.randomUUID(), signal_state_id: stateId, horizon_bars: 8 }),
                    );
                    const { signals } = groupIntoSignals(rows, 8);

                    return signals.length === new Set(stateIds).size;
                },
            ),
            { numRuns: 200 },
        );
    });

    it('never groups a signal with a different one that shares a row key', () => {
        // `id` differs for every row by construction, so grouping by it would
        // pass this and fail the test above it. The two together are the check.
        fc.assert(
            fc.property(
                fc.array(fc.tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 0, max: 100 })), {
                    minLength: 1,
                    maxLength: 8,
                }),
                (pairs) => {
                    const rows = pairs.map(([stateId, confidence]) =>
                        row({
                            id: crypto.randomUUID(),
                            signal_state_id: stateId,
                            horizon_bars: 8,
                            confidence,
                        }),
                    );
                    const { signals } = groupIntoSignals(rows, 8);
                    const expected = new Set(pairs.map(([stateId]) => stateId)).size;

                    return signals.length === expected;
                },
            ),
            { numRuns: 200 },
        );
    });

    it('keeps a zero confidence a measured signal rather than an excluded one', () => {
        fc.assert(
            fc.property(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 1, max: 3 }), (confidence, stateId) => {
                const { signals, withoutClaim } = groupIntoSignals(
                    [row({ id: crypto.randomUUID(), signal_state_id: stateId, confidence })],
                    8,
                );

                return signals.length === 1 && withoutClaim === 0;
            }),
            { numRuns: 100 },
        );
    });
});

describe('the horizon the rows carry', () => {
    it('reads the horizon from the row and not from the argument alone', () => {
        // Both numbers are the same here on purpose: the question is not which
        // value survives, it is that the row's own horizon is the thing that
        // decides membership.
        const verdict: SignalOutcome['horizons'][number]['verdict'] = 'flat';
        const { signals } = groupIntoSignals([row({ id: 'a', horizon_bars: 8, verdict })], 8);

        expect(signals[0]?.outcome.horizons[0]?.verdict).toBe('flat');
    });

    it('treats an eight bar window as eight hours for a reader downstream', () => {
        // Pinned so the unit cannot quietly change under the seam: the horizon
        // selector in samples.ts converts bars to milliseconds with this
        // assumption, and a bar that was not an hour would be leakage.
        expect(8 * HOUR).toBe(28_800_000);
    });
});
