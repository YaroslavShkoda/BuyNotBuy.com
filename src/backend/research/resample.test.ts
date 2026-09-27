import { describe, expect, it } from 'vitest';

import { resampleToDaily } from './resample.js';

import type { Candle } from '../types/market.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

function hour(
    timestamp: number,
    close: number,
    high = close,
    low = close,
    volume = 1,
): Candle {
    return {
        timestamp,
        open: close,
        high,
        low,
        close,
        volume,
    };
}

function dayStarting(offsetHours: number, closes: readonly number[]): Candle[] {
    const start = Date.UTC(2024, 0, 1) + offsetHours * HOUR;

    return closes.map((close, index) => hour(start + index * HOUR, close));
}

const daily = (hours: readonly Candle[], offsetHours = 0): Candle[] =>
    resampleToDaily(hours, 'UTC', offsetHours);

describe('a day is built from its hours', () => {
    it('opens at the first hour and closes at the last', () => {
        // The only two fields that depend on where the day is cut, and the
        // reason the boundary is a parameter rather than a habit.
        expect(daily(dayStarting(0, [100, 200, 300, 400]))).toHaveLength(0);
        expect(daily(dayStarting(0, Array.from({ length: 24 }, (_, i) => 100 + i)))).toEqual([
            expect.objectContaining({ timestamp: Date.UTC(2024, 0, 1), open: 100, close: 123 }),
        ]);
    });

    it('takes the extremes, not the first and last it saw', () => {
        const hourly = dayStarting(0, [100, 500, 90, 120]).concat(
            Array.from({ length: 20 }, (_, index) =>
                hour(Date.UTC(2024, 0, 1) + (4 + index) * HOUR, 100),
            ),
        );
        const days = daily(hourly);

        expect(days[0]!.high).toBe(500);
        expect(days[0]!.low).toBe(90);
    });

    it('sums the volume of the hours', () => {
        const start = Date.UTC(2024, 0, 1);
        const hours = Array.from({ length: 24 }, (_, index) =>
            hour(start + index * HOUR, 100 + index, 100 + index, 100 + index, index + 1),
        );

        // 1 + 2 + ... + 24. The first version of this test asserted 300, which
        // is the sum of the *prices* — a reminder that a wrong expectation in a
        // test is indistinguishable from a wrong implementation until someone
        // looks at what the helper actually sets.
        expect(daily(hours)[0]!.volume).toBe(300);
    });

    it('does not care what order the hours arrive in', () => {
        const forwards = dayStarting(0, Array.from({ length: 24 }, (_, i) => i + 1));
        const shuffled = [...forwards].reverse();

        expect(daily(shuffled)).toEqual(daily(forwards));
    });
});

describe('a day with a hole in it is not a day', () => {
    it('is dropped rather than published with a high the market never reached', () => {
        // Nineteen hours produce a high and a low that were only ever reached
        // by the gap in the feed. Publishing that is how a backtest ends up
        // placing a stop at a price nothing traded at.
        const nineteen = dayStarting(0, Array.from({ length: 19 }, (_, i) => 100 + i));

        expect(daily(nineteen)).toHaveLength(0);
    });

    it('keeps a full day that sits next to a broken one', () => {
        const complete = dayStarting(0, Array.from({ length: 24 }, (_, i) => 100 + i));
        const broken = dayStarting(24, Array.from({ length: 20 }, (_, i) => 100 + i));

        const days = daily([...complete, ...broken]);

        expect(days).toHaveLength(1);
        expect(days[0]!.timestamp).toBe(Date.UTC(2024, 0, 1));
    });
});

describe('where the day starts', () => {
    it('defaults to midnight, which is the exchange convention', () => {
        const days = daily(dayStarting(0, Array.from({ length: 24 }, () => 1)));

        expect(days[0]!.timestamp).toBe(Date.UTC(2024, 0, 1));
    });

    it('moves the boundary when the data provider puts it elsewhere', () => {
        // The legacy fixture in this repository starts its days at 12:00 UTC.
        // Resampling those with a midnight boundary and comparing them to the
        // fixture is how one gets 2071 days of perfectly good data reported as
        // missing.
        const hours = dayStarting(12, Array.from({ length: 24 }, () => 1));
        const days = daily(hours, 12);

        expect(days).toHaveLength(1);
        expect(days[0]!.timestamp).toBe(Date.UTC(2024, 0, 1) + 12 * HOUR);
        expect(days[0]!.timestamp % DAY).toBe(12 * HOUR);
    });
});

describe('degenerate input', () => {
    it('returns nothing for nothing', () => {
        expect(resampleToDaily([], 'UTC')).toEqual([]);
    });

    it('refuses a time zone it cannot handle rather than assuming UTC', () => {
        // Silently treating an unsupported zone as UTC is how a whole series
        // ends up shifted and nobody knows why.
        expect(() =>
            resampleToDaily(dayStarting(0, [1]), 'Europe/Moscow' as 'UTC'),
        ).toThrow('Unsupported time zone');
    });
});
