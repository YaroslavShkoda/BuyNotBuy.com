import { describe, expect, it } from 'vitest';

import { defaultInstrumentTicker } from './instruments';

describe('default instrument selection', () => {
    it('uses the first active registry entry, not a frontend-specific ticker', () => {
        expect(defaultInstrumentTicker([
            { ticker: 'OLDPAIR', status: 'inactive' },
            { ticker: 'FIRSTPAIR', status: 'active' },
            { ticker: 'SECONDP', status: 'active' },
        ])).toBe('FIRSTPAIR');
    });

    it('returns null when there is no active instrument', () => {
        expect(defaultInstrumentTicker([])).toBeNull();
        expect(defaultInstrumentTicker([{ ticker: 'OLDPAIR', status: 'inactive' }])).toBeNull();
    });
});
