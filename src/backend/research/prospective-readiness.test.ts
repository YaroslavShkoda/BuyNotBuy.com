import { describe, expect, it } from 'vitest';
import { assessProspectiveReadiness } from './prospective-readiness.js';

describe('prospective evidence eligibility', () => {
    const start = Date.UTC(2026, 9, 27);
    const hour = 3_600_000;
    it('never counts explored history or still-open/future bars as prospective evidence', () => {
        expect(assessProspectiveReadiness([start - hour, start, start + hour], {
            start, now: start + hour - 1, intervalMs: hour, minimumIndependentBlocks: 333, registeredAt: start,
        })).toMatchObject({ eligibleBars: 0, calibration: 'not_calibrated', outcome: 'INCONCLUSIVE' });
    });
    it('counts closed prospective bars but refuses a probability claim from a small sample', () => {
        expect(assessProspectiveReadiness([start, start + hour], {
            start, now: start + 2 * hour, intervalMs: hour, minimumIndependentBlocks: 333, registeredAt: start,
        })).toMatchObject({ eligibleBars: 2, calibration: 'insufficient', outcome: 'INCONCLUSIVE' });
    });
    it('does not equate enough correlated bars with validated independent evidence', () => {
        expect(assessProspectiveReadiness(Array.from({ length: 400 }, (_, i) => start + i * hour), {
            start, now: start + 401 * hour, intervalMs: hour, minimumIndependentBlocks: 333, registeredAt: start,
        })).toMatchObject({ calibration: 'not_calibrated', outcome: 'INCONCLUSIVE' });
    });
    it('does not count draft bars and starts after later owner acceptance', () => {
        const options = { start, now: start + 3 * hour, intervalMs: hour, minimumIndependentBlocks: 333 };
        expect(assessProspectiveReadiness([start, start + hour], options).eligibleBars).toBe(0);
        expect(assessProspectiveReadiness([start, start + hour], { ...options, registeredAt: start + hour }).eligibleBars).toBe(1);
    });
    it('refuses duplicate, unsorted, unsafe or invalid timestamps and invalid windows', () => {
        const options = { start, now: start + hour, intervalMs: hour, minimumIndependentBlocks: 333 };
        for (const timestamps of [[start, start], [start, start - 1], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1]]) {
            expect(() => assessProspectiveReadiness(timestamps, options)).toThrow();
        }
        expect(() => assessProspectiveReadiness([], { ...options, intervalMs: 0 })).toThrow();
    });
});
