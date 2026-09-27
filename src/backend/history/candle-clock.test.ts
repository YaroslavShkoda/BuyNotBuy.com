import { describe, expect, it } from 'vitest';

import {
    candleCloseTime,
    formingCandleTime,
    ingestionPeriodMs,
    isCandleClosed,
    lastClosedCandleTime,
    msUntilNextClose,
} from './candle-clock.js';

const CLOCK = { intervalMs: 3_600_000 };
const MINUTE_CLOCK = { intervalMs: 60_000 };
const HOUR = CLOCK.intervalMs;

/**
 * Aligned to the hour on purpose. A venue labels a bar by an instant that sits
 * on a boundary, so a timestamp chosen for looking round would put every
 * expectation in this file a few minutes off and make the exactness claims
 * untestable.
 */
const BOUNDARY = 1_699_999_200_000;

/**
 * The clock is the one place where a plausible-looking answer is enough to
 * produce a wrong one. A bar is closed "about when the hour is over" and
 * everything downstream inherits the error silently, so these are exact
 * rather than approximate: a boundary that moves by a millisecond moves the
 * measured history with it.
 */
describe('candle clock', () => {
    describe('isCandleClosed', () => {
        it('is true once the closing instant has arrived', () => {
            const opened = BOUNDARY;

            expect(
                isCandleClosed(CLOCK, opened, candleCloseTime(CLOCK, opened)),
            ).toBe(true);
        });

        it('is false one millisecond before', () => {
            const opened = BOUNDARY;

            expect(
                isCandleClosed(
                    CLOCK,
                    opened,
                    candleCloseTime(CLOCK, opened) - 1,
                ),
            ).toBe(false);
        });

        it('is true for a bar whose close is long past', () => {
            expect(isCandleClosed(CLOCK, BOUNDARY - 10 * HOUR, BOUNDARY)).toBe(
                true,
            );
        });
    });

    describe('formingCandleTime', () => {
        it('is the start of the bar that contains now', () => {
            const now = BOUNDARY + 123_456;

            expect(formingCandleTime(CLOCK, now)).toBe(BOUNDARY);
        });

        it('is null exactly on a boundary', () => {
            // One instant per hour, and it is the one where a floor-based
            // calculation claims a bar is forming that the venue has not opened.
            expect(formingCandleTime(CLOCK, BOUNDARY + HOUR)).toBeNull();
        });

        it('does not go negative before the epoch', () => {
            expect(formingCandleTime(CLOCK, 1_000)).toBe(0);
        });
    });

    describe('lastClosedCandleTime', () => {
        it('is the bar before the one now forming', () => {
            expect(lastClosedCandleTime(CLOCK, BOUNDARY + 123_456)).toBe(
                BOUNDARY - HOUR,
            );
        });

        it('on a boundary, is the bar that just closed', () => {
            expect(lastClosedCandleTime(CLOCK, BOUNDARY + HOUR)).toBe(BOUNDARY);
        });
    });

    describe('msUntilNextClose', () => {
        it('counts down to the boundary', () => {
            expect(msUntilNextClose(CLOCK, BOUNDARY)).toBe(HOUR);
            expect(msUntilNextClose(CLOCK, BOUNDARY + 1)).toBe(HOUR - 1);
        });

        it('is a whole interval when now sits exactly on one', () => {
            // Rounded up, deliberately. A schedule that fires on the wrong side
            // of the boundary is looking for a bar that does not exist yet.
            expect(msUntilNextClose(CLOCK, BOUNDARY + HOUR)).toBe(HOUR);
        });

        it('never returns zero', () => {
            for (let offset = 0; offset < 10; offset += 1) {
                expect(msUntilNextClose(MINUTE_CLOCK, BOUNDARY + offset)).toBe(
                    60_000 - offset,
                );            }
        });
    });

    describe('ingestionPeriodMs', () => {
        it('is a fraction of the interval, not the interval', () => {
            // A bar is only worth looking for after it closes, so a period
            // longer than the interval would wait for one that cannot exist.
            expect(ingestionPeriodMs(3_600_000, 3_600_000)).toBeLessThan(
                3_600_000,
            );
        });

        it('ticks several times per bar so a missed tick costs a delay', () => {
            expect(ingestionPeriodMs(3_600_000, 3_600_000)).toBe(450_000);
        });

        it('never goes below a second', () => {
            // A sub-minute interval must not turn the poll into a request loop.
            expect(ingestionPeriodMs(1_000, 10_000)).toBe(1_000);
        });

        it('honours the cap', () => {
            expect(ingestionPeriodMs(86_400_000, 60_000)).toBe(60_000);
        });

        it('keeps the period below the interval whatever the cap says', () => {
            expect(ingestionPeriodMs(3_600_000, 10_000_000)).toBe(450_000);
        });
    });
});
