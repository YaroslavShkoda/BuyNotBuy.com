import { expect, expectTypeOf, it } from 'vitest';
import type { BoundaryValue, MarginAssessmentV1, Reason3, Result } from '../../types/margin-assessment.js';

it('keeps value/reason invariants and venue claims constrained at compile time', () => {
    const valid: Result<number> = { status: 'valid', value: 1, reasons: [] };
    const degraded: Result<number> = { status: 'degraded', value: null, reasons: ['UNKNOWN_FUNDING'] };
    expect(valid.value).toBe(1);
    expect(degraded.value).toBeNull();

    // @ts-expect-error A valid numeric result must contain a number.
    const missing: Result<number> = { status: 'valid', value: null, reasons: [] };
    // @ts-expect-error A nonvalid result cannot publish a number.
    const provisional: Result<number> = { status: 'degraded', value: 1, reasons: ['UNKNOWN_FUNDING'] };
    // @ts-expect-error A nonvalid result needs at least one reason.
    const silent: Result<number> = { status: 'calculation_error', value: null, reasons: [] };
    // @ts-expect-error A valid result cannot carry a failure reason.
    const ambiguous: Result<number> = { status: 'valid', value: 1, reasons: ['UNKNOWN_FUNDING'] };
    // @ts-expect-error Venue conformance cannot be asserted by this contract.
    const venue: MarginAssessmentV1['basis'] = { kind: 'venue_rules', venueConformance: 'verified' };
    // @ts-expect-error Unreachable needs a path, domain and proof identity.
    const unproved: BoundaryValue = { kind: 'unreachable' };
    void [missing, provisional, silent, ambiguous, venue, unproved];

    expectTypeOf<MarginAssessmentV1['basis']['kind']>().toEqualTypeOf<'mathematical_model'>();
    expectTypeOf<MarginAssessmentV1['basis']['venueConformance']>().toEqualTypeOf<'not_asserted'>();
    expectTypeOf<MarginAssessmentV1['capabilities']['cross']>().toEqualTypeOf<'unsupported'>();
    expectTypeOf<MarginAssessmentV1['capabilities']['inverse']>().toEqualTypeOf<'unsupported'>();
    expectTypeOf<MarginAssessmentV1['capabilities']['venueRules']>().toEqualTypeOf<'unsupported'>();
    expectTypeOf<Reason3>().exclude<'UNSUPPORTED_SCOPE'>().not.toBeNever();
});
