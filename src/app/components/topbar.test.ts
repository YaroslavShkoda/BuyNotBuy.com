import { describe, expect, it } from 'vitest';

import { formatUpdatedAt } from './topbar';

// Local-date constructors keep these cases timezone-independent:
// both timestamps and the reference "now" shift together with the host TZ.
const now = new Date(2026, 8, 24, 12, 0, 0);

describe('topbar updated-at presentation', () => {
    it('renders bare time for a same-day timestamp', () => {
        const label = formatUpdatedAt(new Date(2026, 8, 24, 10, 30, 0).getTime(), now);

        expect(label).toBe('10:30');
    });

    it('includes the date for an older timestamp so stale data does not look fresh', () => {
        const label = formatUpdatedAt(new Date(2026, 8, 23, 10, 30, 0).getTime(), now);

        expect(label).toContain('23.09');
        expect(label).toContain('10:30');
    });

    it('falls back to a dash placeholder for invalid, zero and negative timestamps', () => {
        expect(formatUpdatedAt(Number.NaN, now)).toBe('—');
        expect(formatUpdatedAt(Number.POSITIVE_INFINITY, now)).toBe('—');
        expect(formatUpdatedAt(0, now)).toBe('—');
        expect(formatUpdatedAt(-1_000, now)).toBe('—');
    });
});
