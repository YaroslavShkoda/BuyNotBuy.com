import { describe, expect, it } from 'vitest';
import { STAGE3_ARITHMETIC_VERSION } from './arithmetic.js';
import {
    buildMarginAssessment, MARGIN_ASSESSMENT_BUILDER_VERSION, prepareAssessmentContext,
} from './assessment-builder.js';
import type { PreparedIdentityContext, PreparedMarginInput } from './canonicalization.js';
import { readCanonicalMarginInput } from './canonicalization.js';
import { baseline, contextHandle, corpus, inputHandle, value } from './test-support/identity-fixtures.js';

function breachedInputText(): string {
    const input = baseline();
    input.snapshot.qtyBase = 1;
    input.snapshot.entryPriceQuotePerBase = 100;
    input.snapshot.netCashQuote = 1;
    input.snapshot.valuation.priceQuotePerBase = 50;
    return JSON.stringify(input);
}

function underflowInputText(): string {
    const input = baseline();
    input.snapshot.qtyBase = 5e-324;
    input.snapshot.entryPriceQuotePerBase = 2;
    input.snapshot.netCashQuote = 0;
    input.snapshot.valuation.priceQuotePerBase = 1;
    return JSON.stringify(input);
}

describe('buildMarginAssessment', () => {
    it('assembles the corpus baseline into a valid assessment', () => {
        const assessment = value(buildMarginAssessment(
            inputHandle(), value(prepareAssessmentContext()),
        ));

        expect(assessment.schemaVersion).toBe('margin-assessment/1');
        expect(assessment.basis).toEqual({ kind: 'mathematical_model', venueConformance: 'not_asserted' });
        expect(assessment.quoteCurrency).toBe('QUOTE');
        expect(assessment.capabilities).toEqual({
            boundary: 'verified_flat_model',
            cross: 'unsupported',
            inverse: 'unsupported',
            venueRules: 'unsupported',
        });
        expect(assessment.status).toBe('valid');
        expect(Object.values(assessment.metrics).map((metric) => metric.status)).toEqual([
            'valid', 'valid', 'valid', 'valid', 'valid', 'valid', 'valid', 'valid', 'not_applicable',
        ]);
        expect(assessment.metrics.unrealizedPnlQuote).toEqual({ status: 'valid', value: 500, reasons: [] });
        expect(assessment.metrics.equityQuote).toEqual({ status: 'valid', value: 500, reasons: [] });
        expect(assessment.metrics.initialMarginQuote).toEqual({ status: 'valid', value: 4100, reasons: [] });
        expect(assessment.metrics.maintenanceMarginQuote).toEqual({ status: 'valid', value: 205, reasons: [] });
        expect(assessment.metrics.maintenanceBufferQuote).toEqual({ status: 'valid', value: 295, reasons: [] });
        expect(assessment.metrics.initialMarginSurplusQuote)
            .toEqual({ status: 'valid', value: -3600.0000000000005, reasons: [] });
        expect(assessment.metrics.maintenanceRequirementToEquity)
            .toEqual({ status: 'valid', value: 0.41000000000000003, reasons: [] });
        expect(assessment.metrics.effectiveGrossLeverage).toEqual({ status: 'valid', value: 41, reasons: [] });
        expect(assessment.metrics.entryCollateralLeverage)
            .toEqual({ status: 'not_applicable', value: null, reasons: ['ZERO_COLLATERAL'] });
        expect(assessment.maintenance).toEqual({
            status: 'valid',
            reasons: [],
            value: { exactRelation: 'positive', comparison: 'lt', state: 'above_threshold', detected: false },
        });
        expect(assessment.boundary.status).toBe('valid');
        expect(assessment.boundary.value).toEqual({
            kind: 'boundary',
            priceQuotePerBase: 40404.0404040404,
            publication: 'rounded_exact_boundary',
            boundaryKind: 'root',
            triggersAtExactBoundary: false,
            path: 'long_price_decrease',
            domain: 'positive_real_prices',
        });
    });

    it('carries S3-03 provenance, pinned to the corpus identity vector', () => {
        const vector = corpus.identities[0];
        if (vector === undefined) throw new Error('missing corpus baseline');
        const pinned = value(buildMarginAssessment(inputHandle(), contextHandle()));
        expect(pinned.assessmentId).toBe(vector.assessmentId);
        expect(pinned.provenance.inputHash).toBe(vector.inputHash);
        expect(pinned.provenance.policyHash).toBe(vector.policyHash);
        expect(pinned.provenance.modelId).toBe('generic-linear-isolated');
        expect(pinned.provenance.modelVersion).toBe('1');
        expect(pinned.provenance.source).toBe('manual');
        expect(pinned.provenance.sourceReference).toBe('corpus-record');
        expect(pinned.provenance.snapshotAsOf).toBe(1700000000000);
        expect(pinned.provenance.valuationAsOf).toBe(1700000000000);

        const own = value(buildMarginAssessment(inputHandle(), value(prepareAssessmentContext())));
        expect(own.provenance.engineVersion).toBe(MARGIN_ASSESSMENT_BUILDER_VERSION);
        expect(own.provenance.arithmeticVersion).toBe(STAGE3_ARITHMETIC_VERSION);
        expect(own.provenance.canonicalizationVersion).toBe('margin-canonical-json/1');
        expect(own.provenance.inputHash).toBe(pinned.provenance.inputHash);
        // A different context is a different identity, honestly visible.
        expect(own.assessmentId).not.toBe(pinned.assessmentId);
        expect(own.assessmentId).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic for the same input text and context', () => {
        const first = value(buildMarginAssessment(inputHandle(), value(prepareAssessmentContext())));
        const second = value(buildMarginAssessment(inputHandle(), value(prepareAssessmentContext())));
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it('serializes to JSON without losing shape and without nonfinite tokens', () => {
        for (const text of [undefined, breachedInputText(), underflowInputText()]) {
            const assessment = value(buildMarginAssessment(inputHandle(text), value(prepareAssessmentContext())));
            const text1 = JSON.stringify(assessment);
            expect(text1).not.toMatch(/NaN|Infinity/);
            expect(JSON.parse(text1)).toEqual(JSON.parse(JSON.stringify(assessment)));
            expect(JSON.parse(text1)).toEqual(assessment);
        }
    });

    it('propagates refusals verbatim and keeps the worst status on top', () => {
        const underflow = value(buildMarginAssessment(
            inputHandle(underflowInputText()), value(prepareAssessmentContext()),
        ));
        expect(underflow.status).toBe('calculation_error');
        expect(underflow.metrics.initialMarginQuote)
            .toEqual({ status: 'calculation_error', value: null, reasons: ['NUMERIC_UNDERFLOW'] });
        expect(underflow.metrics.maintenanceMarginQuote)
            .toEqual({ status: 'calculation_error', value: null, reasons: ['NUMERIC_UNDERFLOW'] });
        expect(underflow.maintenance)
            .toEqual({ status: 'calculation_error', value: null, reasons: ['NUMERIC_UNDERFLOW'] });
        expect(underflow.metrics.maintenanceRequirementToEquity)
            .toEqual({ status: 'not_applicable', value: null, reasons: ['NON_POSITIVE_EQUITY'] });
        // The boundary is exact-relative: breach detection survives metric refusals.
        expect(underflow.boundary).toEqual({ status: 'valid', reasons: [], value: { kind: 'already_breached' } });
        for (const part of Object.values(underflow.metrics)) {
            if (part.status === 'valid') expect(part.value).not.toBeNull();
            else expect(part.value).toBeNull();
        }
    });

    it('keeps an exact breach valid while unavailable ratios cannot drag it down', () => {
        const breached = value(buildMarginAssessment(
            inputHandle(breachedInputText()), value(prepareAssessmentContext()),
        ));
        expect(breached.status).toBe('valid');
        expect(breached.maintenance.value).toEqual({
            exactRelation: 'negative', comparison: 'lt', state: 'below_threshold', detected: true,
        });
        expect(breached.boundary).toEqual({ status: 'valid', reasons: [], value: { kind: 'already_breached' } });
        expect(breached.metrics.maintenanceRequirementToEquity)
            .toEqual({ status: 'not_applicable', value: null, reasons: ['NON_POSITIVE_EQUITY'] });
    });

    it('refuses handles that bypassed the preparation boundary', () => {
        const forged = {} as PreparedMarginInput;
        expect(buildMarginAssessment(forged, value(prepareAssessmentContext())))
            .toEqual({ ok: false, error: { code: 'UNTRUSTED_INPUT' } });
        const noContext = {} as PreparedIdentityContext;
        expect(buildMarginAssessment(inputHandle(), noContext))
            .toEqual({ ok: false, error: { code: 'UNTRUSTED_CONTEXT' } });
    });

    it('leaves the input handle and its canonical state unchanged', () => {
        const handle = inputHandle();
        const before = JSON.stringify(value(readCanonicalMarginInput(handle)));
        const first = value(buildMarginAssessment(handle, value(prepareAssessmentContext())));
        const second = value(buildMarginAssessment(handle, value(prepareAssessmentContext())));
        const after = JSON.stringify(value(readCanonicalMarginInput(handle)));
        expect(after).toBe(before);
        expect(second.assessmentId).toBe(first.assessmentId);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });
});
