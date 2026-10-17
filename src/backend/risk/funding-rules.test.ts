import { describe, expect, it } from 'vitest';

import { CONTRACT_KINDS } from '../types/risk.js';
import { fundingApplicability, fundingAvailability } from './funding-rules.js';

/**
 * Funding applicability is a decision per contract kind, recorded exhaustively.
 * The tests hold the record to its own promise: every supported kind has an
 * explicit answer, and a missing reading is never mistaken for a zero rate.
 */

describe('fundingApplicability', () => {
    it('answers for every supported contract kind', () => {
        for (const kind of CONTRACT_KINDS) {
            expect(['applicable', 'not_applicable']).toContain(fundingApplicability(kind));
        }
    });

    it('spot does not carry funding', () => {
        expect(fundingApplicability('spot')).toBe('not_applicable');
    });

    it('perpetuals carry funding', () => {
        expect(fundingApplicability('linear_perp')).toBe('applicable');
        expect(fundingApplicability('inverse_perp')).toBe('applicable');
    });
});

describe('fundingAvailability', () => {
    it('not applicable wins for spot, whatever the rate field says', () => {
        expect(fundingAvailability('spot', null)).toEqual({
            status: 'not_applicable',
            reasonCode: 'FUNDING_NOT_APPLICABLE',
        });
        expect(fundingAvailability('spot', 0.0001)).toEqual({
            status: 'not_applicable',
            reasonCode: 'FUNDING_NOT_APPLICABLE',
        });
    });

    it('a missing applicable reading degrades rather than pretending zero', () => {
        expect(fundingAvailability('linear_perp', null)).toEqual({
            status: 'degraded',
            reasonCode: 'UNKNOWN_FUNDING',
        });
    });

    it('a provided reading is valid — including an explicit zero rate', () => {
        // A supplied 0 is a market reading; null is no reading. The two are
        // different facts and must stay different.
        expect(fundingAvailability('linear_perp', 0)).toEqual({
            status: 'valid',
            reasonCode: null,
        });
        expect(fundingAvailability('inverse_perp', -0.0001)).toEqual({
            status: 'valid',
            reasonCode: null,
        });
    });
});
