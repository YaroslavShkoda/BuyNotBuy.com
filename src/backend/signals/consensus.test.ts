import { describe, expect, it } from 'vitest';

import {
    calculateConsensus,
    clampWeight,
    wilsonLowerBound,
} from './consensus.js';
import type {
    IndicatorAnalysis,
    IndicatorKey,
    IndicatorSignal,
} from './signal.types.js';

const identities: Array<{ key: IndicatorKey; name: string }> = [
    { key: 'ema', name: 'EMA 300' },
    { key: 'stochastic', name: 'Стохастик' },
    { key: 'momentum', name: 'Momentum 100' },
];

function makeAnalyses(
    ...signals: Array<[IndicatorSignal, number]>
): IndicatorAnalysis[] {
    return signals.map(([signal, weight], index) => {
        const identity = identities[index] ?? { key: 'ema' as IndicatorKey, name: `Indicator ${index}` };

        return {
            key: identity.key,
            name: identity.name,
            signal,
            reason: `${identity.name} ${signal}`,
            weight,
        };
    });
}

function makeUnweighted(
    ...signals: IndicatorSignal[]
): IndicatorAnalysis[] {
    return makeAnalyses(
        ...signals.map(
            (signal) =>
                [
                    signal,
                    signal === 'NEUTRAL' ? 0 : 1,
                ] as [IndicatorSignal, number],
        ),
    );
}

describe('clampWeight', () => {
    it('clamps into [0, 1]', () => {
        expect(clampWeight(-0.5)).toBe(0);
        expect(clampWeight(0.25)).toBe(0.25);
        expect(clampWeight(4)).toBe(1);
    });

    it('treats a non-finite weight as no opinion', () => {
        expect(clampWeight(Number.NaN)).toBe(0);
        expect(clampWeight(Number.POSITIVE_INFINITY)).toBe(0);
    });
});

describe('wilsonLowerBound', () => {
    it('is zero when nothing was counted', () => {
        expect(wilsonLowerBound(0, 0)).toBe(0);
    });

    it('is below the observed share', () => {
        const bound = wilsonLowerBound(17, 23);

        expect(bound).toBeLessThan(17 / 23);
        expect(bound).toBeGreaterThan(0);
    });

    it('is high for a unanimous but small sample', () => {
        expect(wilsonLowerBound(300, 300)).toBeGreaterThan(0.98);
    });

    it('falls as the sample shrinks', () => {
        expect(wilsonLowerBound(20, 20)).toBeLessThan(
            wilsonLowerBound(200, 200),
        );
    });
});

describe('calculateConsensus', () => {
    it('returns LONG with a high confidence when all three vote LONG', () => {
        const result = calculateConsensus(
            makeUnweighted('LONG', 'LONG', 'LONG'),
        );

        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBe(99);
        expect(result.reason).toBe(
            'EMA 300, Стохастик и Momentum 100 подтверждают LONG',
        );
    });

    it('returns SHORT with a high confidence when all three vote SHORT', () => {
        const result = calculateConsensus(
            makeUnweighted('SHORT', 'SHORT', 'SHORT'),
        );

        expect(result.signal).toBe('SHORT');
        expect(result.confidence).toBe(99);
        expect(result.reason).toBe(
            'EMA 300, Стохастик и Momentum 100 подтверждают SHORT',
        );
    });

    it('drops the confidence when the third indicator votes the other way', () => {
        const result = calculateConsensus(
            makeUnweighted('LONG', 'LONG', 'SHORT'),
        );

        expect(result.signal).toBe('LONG');
        // The old recount answered 67 here. A 2-to-1 split on three
        // indicators is nowhere near 67% certain.
        expect(result.confidence).toBe(61);
        expect(result.reason).toBe('EMA 300 и Стохастик подтверждают LONG');
    });

    it('keeps the confidence high when the dissenting indicator abstains', () => {
        const result = calculateConsensus(
            makeUnweighted('LONG', 'LONG', 'NEUTRAL'),
        );

        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBe(98);
        expect(result.reason).toBe(
            'Только EMA 300 и Стохастик подтверждают LONG',
        );
    });

    it('refuses to call a single vote a direction', () => {
        // This is the state the dashboard used to present as a confident
        // 33% LONG, because NEUTRAL was counted as a vote against nothing.
        const result = calculateConsensus(
            makeUnweighted('LONG', 'NEUTRAL', 'NEUTRAL'),
        );

        expect(result).toEqual({
            signal: 'NEUTRAL',
            confidence: 0,
            reason: 'Нет большинства: только EMA 300 за LONG',
        });
    });

    it('refuses a lone SHORT vote just as firmly', () => {
        const result = calculateConsensus(
            makeUnweighted('NEUTRAL', 'NEUTRAL', 'SHORT'),
        );

        expect(result.signal).toBe('NEUTRAL');
        expect(result.confidence).toBe(0);
        expect(result.reason).toBe(
            'Нет большинства: только Momentum 100 за SHORT',
        );
    });

    it('preserves NEUTRAL on a one to one conflict', () => {
        const result = calculateConsensus(
            makeUnweighted('SHORT', 'LONG', 'NEUTRAL'),
        );

        expect(result).toEqual({
            signal: 'NEUTRAL',
            confidence: 0,
            reason: 'Индикаторы дают противоположные сигналы',
        });
    });

    it('returns NEUTRAL with 0% when every indicator abstains', () => {
        const result = calculateConsensus(
            makeUnweighted('NEUTRAL', 'NEUTRAL', 'NEUTRAL'),
        );

        expect(result).toEqual({
            signal: 'NEUTRAL',
            confidence: 0,
            reason: 'Ни один индикатор не даёт сигнала',
        });
    });

    it('refuses a consensus that is unanimous but only just clears the thresholds', () => {
        // All three agree, so the Wilson bound is at its maximum. But they got
        // there by a hair, and publishing 99% for that would be a lie.
        const result = calculateConsensus(
            makeAnalyses(
                ['LONG', 0.05],
                ['LONG', 0.05],
                ['NEUTRAL', 0],
            ),
        );

        expect(result).toEqual({
            signal: 'NEUTRAL',
            confidence: 0,
            reason: 'EMA 300 и Стохастик едва подтверждают LONG',
        });
    });

    it('still publishes a consensus that clears the conviction floor', () => {
        const result = calculateConsensus(
            makeAnalyses(
                ['LONG', 0.4],
                ['LONG', 0.3],
                ['NEUTRAL', 0],
            ),
        );

        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBe(95);
    });

    it('ranks a decisive pair above a mixed-strength one', () => {
        const decisive = calculateConsensus(
            makeAnalyses(
                ['LONG', 1],
                ['LONG', 1],
                ['NEUTRAL', 0],
            ),
        );

        const mixed = calculateConsensus(
            makeAnalyses(
                ['LONG', 1],
                ['LONG', 0.6],
                ['SHORT', 0.5],
            ),
        );

        expect(mixed.confidence).toBeLessThan(decisive.confidence);
    });

    it('ignores the weight of a neutral indicator entirely', () => {
        const without = calculateConsensus(
            makeAnalyses(['LONG', 1], ['LONG', 0.6], ['NEUTRAL', 0]),
        );

        const polluted = calculateConsensus(
            makeAnalyses(['LONG', 1], ['LONG', 0.6], ['NEUTRAL', 0.9]),
        );

        expect(polluted.confidence).toBe(without.confidence);
    });

    it('survives an empty indicator list', () => {
        expect(calculateConsensus([])).toEqual({
            signal: 'NEUTRAL',
            confidence: 0,
            reason: 'Ни один индикатор не даёт сигнала',
        });
    });

    it('ignores a non-finite weight instead of poisoning the ratio', () => {
        const result = calculateConsensus(
            makeAnalyses(
                ['LONG', 1],
                ['LONG', Number.NaN],
                ['NEUTRAL', 0],
            ),
        );

        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBeGreaterThan(0);
        expect(result.confidence).toBeLessThanOrEqual(100);
    });
});
