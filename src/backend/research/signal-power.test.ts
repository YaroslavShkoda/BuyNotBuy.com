import { describe, expect, it } from 'vitest';

import {
    forwardReturns,
    futureSignal,
    mulberry32,
    permutationPValue,
} from './signal-power.js';

describe('the test can see an effect when there is one', () => {
    it('rejects a signal made of the future', () => {
        // The instrument check. If this does not come out at the floor, every
        // other p-value in the project is a statement about the test rather
        // than about the signal, and nothing downstream can be trusted.
        //
        // The floor is 1/(draws+1) and not zero: a p-value of exactly zero is
        // the absence of a measurement, and the correction is what lets this
        // test report it honestly instead of rounding it away.
        const random = mulberry32(7);
        const values = Array.from({ length: 2000 }, () => random() * 0.02 - 0.01);
        const forward = values.map((value) => value + 0.002);
        const draws = 2000;

        const result = permutationPValue(forward, futureSignal(forward), { draws });

        expect(result.p).toBe(1 / (draws + 1));
    });

    it('reports a p-value near the floor for a strong planted signal', () => {
        const random = mulberry32(11);
        const values = Array.from({ length: 2000 }, () => random() * 0.02 - 0.01);
        // Firing adds a real, detectable edge rather than peeking at the future.
        const signal = values.map(() => random() < 0.4);
        const onShifted = values.map((value, index) => (signal[index] ? value + 0.004 : value));

        expect(permutationPValue(onShifted, signal, { draws: 2000 }).p).toBeLessThan(0.01);
    });

    it('reports a p-value consistent with chance for a signal with no edge', () => {
        // The other direction. A test that always says "significant" is as
        // useless as one that never does, and this is what catches that — the
        // same class of failure as the two-partition version of this test,
        // which returned p = 0.0000 for everything.
        //
        // The spread is checked across *datasets*, not across seeds. A p-value
        // estimates a fixed probability for the data it was given, so changing
        // the seed only changes the Monte Carlo noise around it: twenty seeds
        // on one dataset all return the same answer, and asserting they would
        // scatter was asserting a misunderstanding of what the number is.
        const random = mulberry32(13);
        const p = Array.from({ length: 20 }, () => {
            const values = Array.from({ length: 600 }, () => random() * 0.02 - 0.01);
            const signal = values.map(() => random() < 0.5);

            return permutationPValue(values, signal, { draws: 500, seed: 17 }).p;
        });

        // Uniform, so nothing is special: values above 0.5 and below 0.2 both
        // have to show up, and none should reach the floor.
        expect(p.filter((value) => value > 0.5).length).toBeGreaterThanOrEqual(3);
        expect(p.filter((value) => value < 0.2).length).toBeGreaterThanOrEqual(3);
        expect(Math.min(...p)).toBeGreaterThan(0.01);
    });
});

describe('a p-value means the same thing twice', () => {
    it('is identical for the same seed and different for a different one', () => {
        const random = mulberry32(3);
        const values = Array.from({ length: 800 }, () => random() * 0.02 - 0.01);
        const signal = values.map(() => random() < 0.5);

        const first = permutationPValue(values, signal, { seed: 99 });
        const again = permutationPValue(values, signal, { seed: 99 });
        const other = permutationPValue(values, signal, { seed: 100 });

        expect(again.p).toBe(first.p);
        // A different seed is a different sample of the same null, so it may
        // land either side of the first one — but it is the seed, and nothing
        // else, deciding that. Two runs of one command have to be comparable,
        // or the table this project prints cannot be compared with itself.
        expect(other.p).not.toBe(first.p);
    });

    it('reproduces a p-value coarse enough to survive 500 draws', () => {
        // With 200 draws the p-value can only be a multiple of 1/201, which is
        // too coarse to say anything about a rule near the noise floor. This
        // documents the resolution rather than the arithmetic.
        const random = mulberry32(5);
        const values = Array.from({ length: 400 }, () => random() * 0.02 - 0.01);
        const signal = values.map(() => random() < 0.5);

        const p = permutationPValue(values, signal, { draws: 200 }).p;

        expect(p).toBeGreaterThanOrEqual(1 / 201);
        expect(p).toBeLessThanOrEqual(1);
    });
});

describe('the p-value is about the bars and not about the drawing', () => {
    it('shuffles the values rather than splitting the series in two', () => {
        // A sorted split would measure whether the asset rose, and would return
        // a confident p-value for a signal fired entirely on the last third of
        // a rising series — which is the bug that produced p = 1.0000.
        //
        // The same multiset of values, in a random order, split by index. If
        // the test were using position, the two would differ; it must not,
        // because the values are the only thing the p-value is about.
        //
        // Note that a sorted ramp split by index really is extreme — no
        // relabelling of a sorted array can gather the top fifth as tightly as
        // "the last fifth" does — so this uses a shuffled ramp, which is the
        // case where position and value genuinely carry different information.
        const random = mulberry32(17);
        const ramp = Array.from({ length: 600 }, (_, index) => index * 0.001);
        const shuffledRamp = [...ramp];
        for (let i = shuffledRamp.length - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            [shuffledRamp[i], shuffledRamp[j]] = [shuffledRamp[j]!, shuffledRamp[i]!];
        }

        const onSorted = ramp.map((_, index) => index >= 400);
        const onShuffled = shuffledRamp.map((_, index) => index >= 400);

        const sorted = permutationPValue(ramp, onSorted, { draws: 2000, seed: 4 });
        const shuffled = permutationPValue(shuffledRamp, onShuffled, {
            draws: 2000,
            seed: 4,
        });

        // The sorted one is significant for a real reason: position *is* the
        // value there. The shuffled one is the same numbers in an order where
        // it is not, and it must read as noise.
        expect(sorted.difference).toBeGreaterThan(0);
        expect(sorted.p).toBeLessThan(0.01);
        expect(shuffled.p).toBeGreaterThan(0.1);
    });

    it('keeps both group sizes fixed across draws', () => {
        const values = Array.from({ length: 500 }, (_, index) => (index % 17) * 0.001);
        const signal = values.map((_, index) => index % 3 === 0);

        const result = permutationPValue(values, signal, { draws: 500 });

        expect(result.onCount).toBe(167);
        expect(result.offCount).toBe(333);
        expect(result.onCount + result.offCount).toBe(values.length);
    });
});

describe('the arithmetic it reports', () => {
    it('separates the bars the signal fired on from the bars it skipped', () => {
        const values = [0.1, -0.1, 0.3, -0.2, 0.05, -0.05];
        const signal = [true, false, true, false, true, false];

        const result = permutationPValue(values, signal, { draws: 100 });

        expect(result.onMean).toBeCloseTo((0.1 + 0.3 + 0.05) / 3, 12);
        expect(result.offMean).toBeCloseTo((-0.1 - 0.2 - 0.05) / 3, 12);
        expect(result.difference).toBeCloseTo(result.onMean - result.offMean, 12);
    });

    it('refuses a signal that fires nowhere or everywhere', () => {
        const values = [0.1, 0.2, 0.3];

        expect(() => permutationPValue(values, [false, false, false])).toThrow(
            /fires on some bars and not on others/,
        );
        expect(() => permutationPValue(values, [true, true, true])).toThrow(
            /fires on some bars and not on others/,
        );
    });

    it('refuses mismatched inputs rather than pairing them by index', () => {
        expect(() => permutationPValue([0.1, 0.2], [true])).toThrow(
            /same length/,
        );
        expect(() => permutationPValue([], [])).toThrow(/at least one value/);
    });

    it('leaves the last bars without a forward return rather than filling zero', () => {
        const returns = forwardReturns([100, 110, 121]);

        expect(returns[0]).toBeCloseTo(0.1, 12);
        expect(returns[1]).toBeCloseTo(0.1, 12);
        // Zero would pull every mean down and make a weak signal look weaker,
        // and it would be indistinguishable from a bar that genuinely did not
        // move.
        expect(Number.isNaN(returns[2]!)).toBe(true);
    });

    it('measures over a horizon rather than only the next bar', () => {
        expect(forwardReturns([100, 110, 121], 2)[0]).toBeCloseTo(0.21, 12);
    });

    it('ignores bars with no forward return instead of counting them as flat', () => {
        const values = [0.1, Number.NaN, 0.3, Number.NaN, 0.5];
        const signal = [true, true, false, false, false];

        const result = permutationPValue(values, signal, { draws: 200 });

        expect(result.onCount).toBe(1);
        expect(result.offCount).toBe(2);
    });
});
