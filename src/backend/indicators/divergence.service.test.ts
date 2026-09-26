import { describe, expect, it } from 'vitest';

import type { Candle } from '../types/market.js';

import {
    analyzeDivergence,
} from './divergence.service.js';

function createCandle(
    close: number,
    index: number,
): Candle {
    return {
        timestamp: index,
        open: close,
        high: close,
        low: close,
        close,
        volume: 100,
    };
}

function createCandles(
    closes: number[],
): Candle[] {
    return closes.map(
        (close, index) =>
            createCandle(close, index),
    );
}

const bullishCloses = [
    100, 92, 84, 76, 70, 76, 72, 68,
    66, 69, 66, 63, 64, 62, 65,
];

describe('analyzeDivergence', () => {
    it('detects a bullish divergence on realistic positive prices', () => {
        // Two legs down: a sharp sell-off into index 4, then a slow grind to
        // lower lows. Price keeps making lower lows while the rate of change
        // makes higher lows - that is the bullish divergence.
        //
        // The previous version of this test drove the series through negative
        // prices, which is impossible for a spot market and hid the fact that
        // nothing in the pipeline was verified against realistic data.
        const result = analyzeDivergence(
            createCandles(bullishCloses),
            {
                momentumPeriod: 3,
                leftWindow: 1,
                rightWindow: 1,
                maxDistance: 20,
            },
        );

        expect(result.bearish).toBeNull();

        const bullish = result.bullish;

        expect(bullish?.type).toBe('BULLISH');
        expect(bullish?.previous.price).toBe(70);
        expect(bullish?.current.price).toBe(66);
        // Momentum is a percentage now, so these are -13.16% and -7.25%.
        expect(bullish?.previous.momentum).toBeCloseTo(-13.1579, 3);
        expect(bullish?.current.momentum).toBeCloseTo(-7.2464, 3);
    });

    it('reports when each pivot became knowable, not just where it printed', () => {
        const result = analyzeDivergence(
            createCandles(bullishCloses),
            {
                momentumPeriod: 3,
                leftWindow: 1,
                rightWindow: 1,
                maxDistance: 20,
            },
        );

        const bullish = result.bullish;

        expect(bullish).not.toBeNull();

        // A swing pivot is only confirmed after `rightWindow` further bars, so
        // the dashboard must never present it as a current reading earlier.
        expect(bullish?.previous.confirmedAtIndex).toBeGreaterThan(
            bullish?.previous.index ?? 0,
        );
        expect(bullish?.current.confirmedAtIndex).toBeGreaterThan(
            bullish?.current.index ?? 0,
        );
        expect(bullish?.previous.age).toBeGreaterThanOrEqual(0);
        expect(bullish?.current.age).toBeGreaterThanOrEqual(0);
    });

    it('measures the pivot on the wick that made the turn, not on the close', () => {
        const candles = bullishCloses.map((close, index) => ({
            timestamp: index,
            open: close,
            high: close + 5,
            low: close - 5,
            close,
            volume: 100,
        }));

        const result = analyzeDivergence(
            candles,
            {
                momentumPeriod: 3,
                leftWindow: 1,
                rightWindow: 1,
                maxDistance: 20,
            },
        );

        const bullish = result.bullish;

        expect(bullish).not.toBeNull();

        // A bullish formation is a swing low, so its price has to come from
        // `low`. Reading the close shifted both legs five dollars up.
        expect(bullish?.previous.price).toBe(70 - 5);
        expect(bullish?.current.price).toBe(66 - 5);
    });

    it('drops a formation that is too old to describe the market', () => {
        const candles = createCandles(bullishCloses);

        const fresh = analyzeDivergence(candles, {
            momentumPeriod: 3,
            leftWindow: 1,
            rightWindow: 1,
            maxDistance: 20,
            maxAge: 20,
        });

        expect(fresh.bullish).not.toBeNull();

        // Same series, but the pivots are now ancient: reporting them as if
        // they were forming now is what this filter exists to prevent.
        const stale = analyzeDivergence(candles, {
            momentumPeriod: 3,
            leftWindow: 1,
            rightWindow: 1,
            maxDistance: 20,
            maxAge: 0,
        });

        expect(stale.bullish).toBeNull();
        expect(stale.bearish).toBeNull();
    });

    it('is invariant to bars appended after the analysed window', () => {
        // Non-causality check: no result may depend on bars that did not exist
        // when the pivot printed. Analysing a prefix has to give the same
        // answer as analysing the full series, for every prefix.
        const candles = createCandles(bullishCloses);
        const options = {
            momentumPeriod: 3,
            leftWindow: 1,
            rightWindow: 1,
            maxDistance: 20,
            maxAge: 120,
        };

        const full = analyzeDivergence(candles, options);

        expect(full.bullish).not.toBeNull();

        let sawDivergence = 0;

        for (let length = 10; length <= candles.length; length += 1) {
            const prefix = analyzeDivergence(
                candles.slice(0, length),
                options,
            );

            if (prefix.bullish === null) {
                continue;
            }

            sawDivergence += 1;

            expect(prefix.bullish.previous.index).toBe(
                full.bullish?.previous.index,
            );
            expect(prefix.bullish.current.index).toBe(
                full.bullish?.current.index,
            );
            expect(prefix.bullish.previous.price).toBe(
                full.bullish?.previous.price,
            );
            expect(prefix.bullish.current.momentum).toBeCloseTo(
                full.bullish?.current.momentum ?? 0,
                10,
            );
        }

        // Guard against a vacuous property: at least one prefix has to
        // actually produce the divergence.
        expect(sawDivergence).toBeGreaterThan(0);
    });

    it('returns no divergence when there is not enough price history', () => {
        const candles = Array.from(
            { length: 10 },
            (_, index) =>
                createCandle(100 + index, index),
        );

        const result = analyzeDivergence(candles, {
            momentumPeriod: 3,
        });

        expect(result).toEqual({
            bullish: null,
            bearish: null,
        });
    });

    it('returns no divergence when candles are empty', () => {
        expect(() =>
            analyzeDivergence([], { momentumPeriod: 3 }),
        ).toThrow(
            'Divergence analysis requires at least one candle',
        );
    });

    it('throws when max distance is negative', () => {
        const candles = Array.from(
            { length: 20 },
            (_, index) =>
                createCandle(100, index),
        );

        expect(() =>
            analyzeDivergence(candles, {
                momentumPeriod: 3,
                leftWindow: 2,
                rightWindow: 2,
                maxDistance: -1,
            }),
        ).toThrow(
            'Divergence max distance must be greater than or equal to 0',
        );
    });

    it('throws when max age is negative', () => {
        const candles = Array.from(
            { length: 20 },
            (_, index) =>
                createCandle(100, index),
        );

        expect(() =>
            analyzeDivergence(candles, {
                momentumPeriod: 3,
                maxAge: -1,
            }),
        ).toThrow(
            'Divergence max age must be greater than or equal to 0',
        );
    });
});
