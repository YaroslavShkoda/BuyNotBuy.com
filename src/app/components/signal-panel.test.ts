import { describe, expect, it } from 'vitest';

import { getConfidenceWidth, getVoteSummary } from './signal-panel';

import type { IndicatorAnalysis } from '../types/analysis';

describe('signal confidence meter', () => {
    it('maps confidence to a percentage width', () => {
        expect(getConfidenceWidth(67)).toBe('67%');
        expect(getConfidenceWidth(0)).toBe('0%');
        expect(getConfidenceWidth(33)).toBe('33%');
        expect(getConfidenceWidth(100)).toBe('100%');
    });

    it('clamps out-of-range values into 0-100%', () => {
        expect(getConfidenceWidth(120)).toBe('100%');
        expect(getConfidenceWidth(-5)).toBe('0%');
    });

    it('rounds fractional confidence and guards non-finite input', () => {
        expect(getConfidenceWidth(67.4)).toBe('67%');
        expect(getConfidenceWidth(Number.NaN)).toBe('0%');
        expect(getConfidenceWidth(Number.POSITIVE_INFINITY)).toBe('0%');
    });
});

function makeVote(name: string, signal: IndicatorAnalysis['signal']): IndicatorAnalysis {
    return { name, signal, reason: `${name} ${signal}` };
}

describe('signal vote summary', () => {
    it('describes unanimous support', () => {
        const indicators = [
            makeVote('EMA 300', 'LONG'),
            makeVote('Стохастик', 'LONG'),
            makeVote('Momentum 100', 'LONG'),
        ];

        expect(getVoteSummary(indicators, 'LONG')).toBe('Все 3 индикатора поддерживают LONG');
    });

    it('describes partial support with an opposing vote', () => {
        const indicators = [
            makeVote('EMA 300', 'LONG'),
            makeVote('Стохастик', 'SHORT'),
            makeVote('Momentum 100', 'LONG'),
        ];

        expect(getVoteSummary(indicators, 'LONG')).toBe('2 из 3 индикаторов поддерживают LONG · 1 против');
    });

    it('uses singular verb and noun for a single supporting vote', () => {
        const indicators = [
            makeVote('EMA 300', 'LONG'),
            makeVote('Стохастик', 'NEUTRAL'),
            makeVote('Momentum 100', 'NEUTRAL'),
        ];

        expect(getVoteSummary(indicators, 'LONG')).toBe('1 из 3 индикаторов поддерживает LONG');
    });

    it('describes SHORT support', () => {
        const indicators = [
            makeVote('EMA 300', 'SHORT'),
            makeVote('Стохастик', 'SHORT'),
            makeVote('Momentum 100', 'LONG'),
        ];

        expect(getVoteSummary(indicators, 'SHORT')).toBe('2 из 3 индикаторов поддерживают SHORT · 1 против');
    });

    it('returns null for a NEUTRAL signal with opposing votes (backend reason already explains it)', () => {
        const indicators = [
            makeVote('EMA 300', 'LONG'),
            makeVote('Стохастик', 'SHORT'),
            makeVote('Momentum 100', 'NEUTRAL'),
        ];

        expect(getVoteSummary(indicators, 'NEUTRAL')).toBeNull();
    });

    it('returns null for all-neutral votes (backend reason already explains it)', () => {
        const indicators = [
            makeVote('EMA 300', 'NEUTRAL'),
            makeVote('Стохастик', 'NEUTRAL'),
            makeVote('Momentum 100', 'NEUTRAL'),
        ];

        expect(getVoteSummary(indicators, 'NEUTRAL')).toBeNull();
    });

    it('returns null for an empty indicator list', () => {
        expect(getVoteSummary([], 'LONG')).toBeNull();
    });
});
