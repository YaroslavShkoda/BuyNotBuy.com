import { describe, expect, it } from 'vitest';

import { buildVolumeScale } from './volume-scale';

import type { Candle } from '../types/analysis';

const HOUR = 3_600_000;

function candles(volumes: number[]): Candle[] {
    return volumes.map((volume, index) => ({
        timestamp: index * HOUR,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume,
    }));
}

describe('volume bar heights', () => {
    it('lines up with the candles it was built from', () => {
        expect(buildVolumeScale(candles([1, 2, 3, 4]))).toHaveLength(4);
    });

    it('draws a bar at its own norm at half height, and twice the norm full', () => {
        // A flat series is the clean case: every norm equals the constant, so
        // the scale is decided by the ratio alone.
        expect(buildVolumeScale(candles([100, 100, 100]))[1]).toBeCloseTo(0.5, 5);
        expect(buildVolumeScale(candles([200, 100, 100]))[0]).toBeCloseTo(1, 5);
    });

    it('keeps a bar measured against its own past, not the chart maximum', () => {
        // The whole point: a quiet stretch must not be flattened by a spike
        // that happened hours ago.
        const volumes = [100, 100, 100, 100, 1000, 100, 100, 100];
        const scale = buildVolumeScale(candles(volumes));

        expect(scale[5]).toBeCloseTo(0.5, 5);
    });

    it('gives the same height to equal activity on two very different venues', () => {
        // Binance and Bitget report volumes about 39x apart for the same
        // market. Scaled by the chart maximum the second venue would collapse to
        // nothing; measured against its own past it is indistinguishable.
        const binance = [...Array.from({ length: 12 }, () => 30_000_000)];
        const bitget = [...Array.from({ length: 12 }, () => 800_000)];

        const scale = buildVolumeScale(candles([...binance, ...bitget]));

        expect(scale[11]).toBeCloseTo(0.5, 5);
        expect(scale.at(-1)).toBeCloseTo(0.5, 5);
    });

    it('takes a few hours to settle after a venue change, and says so', () => {
        // A trailing median cannot flip before the new data outnumbers the old,
        // so the bars right after a switch are drawn against a mixed norm. This
        // pins that transient rather than leaving it to be discovered: the
        // trade is deliberate, and the alternative — probing the primary venue on
        // every poll — costs a timeout per request for the whole outage.
        const before = [...Array.from({ length: 12 }, () => 30_000_000)];
        const after = [...Array.from({ length: 12 }, () => 800_000)];

        const scale = buildVolumeScale(candles([...before, ...after]));

        // The first bar on the new venue is measured against the old regime.
        expect(scale[12]).toBeLessThan(0.1);
        // And it is back to a normal-looking height within the window.
        expect(scale.at(-1)).toBeCloseTo(0.5, 5);
    });

    it('caps a spike rather than letting it flatten everything around it', () => {
        const scale = buildVolumeScale(candles([100, 100, 100, 1_000_000]));

        expect(scale[3]).toBe(1);
    });

    it('ignores a spike when it works out what normal is', () => {
        // With a mean, one loud bar would drag the reference up and then squash
        // every ordinary bar around it. The median is why this passes.
        const spike = 10_000;
        const scale = buildVolumeScale(candles([100, 100, spike, 100, 100]));

        expect(scale[3]).toBeCloseTo(0.5, 5);
    });

    it('never lets a bar measure itself', () => {
        // A bar inside its own reference would halve its height, so the single
        // loudest bar would be drawn the shortest of all.
        const quiet = [...Array.from({ length: 24 }, () => 100)];
        const scale = buildVolumeScale(candles([...quiet, 800]));

        expect(scale.at(-1)).toBeCloseTo(1, 5);
    });

    it('copes with a series that starts at zero', () => {
        // The opening bars have no past to compare against and fall back to the
        // series median rather than dividing by zero.
        const scale = buildVolumeScale(candles([0, 0, 100, 100, 100]));

        expect(scale.every(Number.isFinite)).toBe(true);
    });

    it('draws a pair that never traded as one flat full block', () => {
        // No normal exists, so there is nothing to be unusual about. Flat would
        // read as "broken" and empty would read as "no data".
        expect(buildVolumeScale(candles([0, 0, 0]))).toEqual([1, 1, 1]);
    });

    it('has nothing to draw for an empty series', () => {
        expect(buildVolumeScale([])).toEqual([]);
    });
});
