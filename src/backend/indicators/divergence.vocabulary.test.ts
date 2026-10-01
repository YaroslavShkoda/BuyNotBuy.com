import { describe, expect, it } from 'vitest';

import { DIVERGENCE_TYPES } from './divergence.js';

import type { DivergencePolarity } from './divergence.js';

/**
 * The divergence vocabulary, and the narrower one derived from it.
 *
 * Three spellings existed: the union in this file, the same three strings
 * retyped in `api/schemas.ts` because `z.enum` wants values, and the narrower
 * `'BULLISH' | 'BEARISH'` written out again in `DivergenceService` for the
 * polarity it expected. The last one is the interesting case — it is not a copy,
 * it is a subset, and writing it out made it *look* like an independent choice
 * rather than what it is: two of the three, never the answer.
 */
describe('divergence vocabulary', () => {
    it('is what the wire validates', async () => {
        // Asserted against the schema's own options. A test comparing two
        // constants and nothing in between passes on broken code, which is how
        // two of this session's guards started out.
        const { DivergenceAnalysisSchema } = await import('../api/schemas.js');

        const bullish = DivergenceAnalysisSchema.shape.bullish.unwrap();

        expect(bullish.shape.type.options).toEqual([...DIVERGENCE_TYPES]);
        expect(bullish.shape.type.options).toEqual(
            DivergenceAnalysisSchema.shape.bearish.unwrap().shape.type.options,
        );
    });

    it('gives the service a polarity that can never be the absence', () => {
        // The subset, stated as the subset. `NONE` is an answer the detector
        // produces; it is not something a caller can expect to find.
        const polarity: DivergencePolarity = 'BULLISH';

        expect(DIVERGENCE_TYPES).toContain(polarity);
        expect(DIVERGENCE_TYPES.filter((t) => t !== 'NONE')).toHaveLength(2);
    });

    it('refuses a polarity nobody defines', () => {
        // The type is what stops `NONE` reaching the expectation; this asserts
        // the list it is drawn from has exactly the three members the detector
        // can return, so "two of three" stays true as the list grows.
        expect([...DIVERGENCE_TYPES].sort()).toEqual(['BEARISH', 'BULLISH', 'NONE']);
    });
});