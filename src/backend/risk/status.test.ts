import { describe, expect, it } from 'vitest';

import type { RiskStatus } from '../types/risk.js';
import { metric, sectionReason, worstStatus } from './status.js';

/**
 * The aggregation rule is the report's honesty: `valid` is never claimed while
 * a part is broken, `not_applicable` never drags a working report down, and a
 * metric that claims validity must carry a number.
 */

describe('worstStatus', () => {
    const cases: readonly [readonly RiskStatus[], RiskStatus][] = [
        [['valid'], 'valid'],
        [['valid', 'not_applicable'], 'valid'],
        [['not_applicable', 'not_applicable'], 'not_applicable'],
        [['valid', 'degraded'], 'degraded'],
        [['degraded', 'not_applicable'], 'degraded'],
        [['degraded', 'insufficient_data'], 'insufficient_data'],
        [['insufficient_data', 'calculation_error'], 'calculation_error'],
        [['valid', 'valid', 'calculation_error'], 'calculation_error'],
    ];

    for (const [statuses, expected] of cases) {
        it(`aggregates [${statuses.join(', ')}] to ${expected}`, () => {
            expect(worstStatus(statuses)).toBe(expected);
        });
    }

    it('aggregates an empty list to valid', () => {
        expect(worstStatus([])).toBe('valid');
    });
});

describe('metric', () => {
    it('gives a section the arithmetic failure reason ahead of unavailable optional data', () => {
        expect(sectionReason([
            metric('exit', 'percent', null, 'not_applicable', 'EXIT_PRICE_NOT_PROVIDED'),
            metric('funding', 'quote_currency', Infinity, 'valid'),
        ])).toBe('CALCULATION_OVERFLOW');
    });

    it.each([NaN, Infinity, -Infinity])('turns %s into an explicit calculation error', (value) => {
        for (const status of ['valid', 'degraded'] as const) {
            const block = metric('m', 'percent', value, status, 'MARGIN_RULES_DRAFT');

            expect(block).toEqual({
                metricKey: 'm', unit: 'percent', value: null,
                status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW',
            });
            expect(JSON.parse(JSON.stringify(block))).toEqual(block);
        }
    });

    it('keeps a valid metric honest: no number, no validity', () => {
        expect(() => metric('m', 'percent', null, 'valid')).toThrow();
    });

    it('demands a reason from every status that is not valid', () => {
        for (const status of [
            'degraded',
            'insufficient_data',
            'not_applicable',
            'calculation_error',
        ] as const) {
            expect(() => metric('m', 'percent', null, status)).toThrow();
        }
    });

    it('accepts a degraded metric with a value and a reason', () => {
        const block = metric('m', 'percent', 1.5, 'degraded', 'MARGIN_RULES_DRAFT');

        expect(block.value).toBe(1.5);
        expect(block.reasonCode).toBe('MARGIN_RULES_DRAFT');
    });
});
