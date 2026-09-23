import { describe, expect, it } from 'vitest';

import { calculateConsensus } from './consensus';
import type { IndicatorAnalysis, IndicatorSignal } from './signal.types';

const names = ['EMA 300', 'Stochastic', 'Momentum 100'];

function makeAnalyses(...signals: IndicatorSignal[]): IndicatorAnalysis[] {
    return signals.map((signal, index) => ({
        name: names[index] ?? `Indicator ${index}`,
        signal,
        reason: `${names[index] ?? `Indicator ${index}`} ${signal}`,
    }));
}

describe('calculateConsensus', () => {
    it('returns LONG with 100% confidence when all three indicators are LONG', () => {
        const result = calculateConsensus(makeAnalyses('LONG', 'LONG', 'LONG'));

        expect(result).toEqual({
            signal: 'LONG',
            confidence: 100,
            reason: 'EMA 300 и Stochastic и Momentum 100 подтверждают LONG',
        });
    });

    it('returns SHORT with 100% confidence when all three indicators are SHORT', () => {
        const result = calculateConsensus(makeAnalyses('SHORT', 'SHORT', 'SHORT'));

        expect(result).toEqual({
            signal: 'SHORT',
            confidence: 100,
            reason: 'EMA 300 и Stochastic и Momentum 100 подтверждают SHORT',
        });
    });

    it('returns the majority LONG with 67% confidence for a two to one split', () => {
        const result = calculateConsensus(makeAnalyses('LONG', 'LONG', 'SHORT'));

        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBe(67);
        expect(result.reason).toBe('EMA 300 и Stochastic подтверждают LONG');
    });

    it('returns the majority SHORT with 67% confidence for a two to one split', () => {
        const result = calculateConsensus(makeAnalyses('SHORT', 'SHORT', 'LONG'));

        expect(result.signal).toBe('SHORT');
        expect(result.confidence).toBe(67);
        expect(result.reason).toBe('EMA 300 и Stochastic подтверждают SHORT');
    });

    it('preserves neutral on a one to one conflict and assigns no support confidence', () => {
        const result = calculateConsensus(makeAnalyses('SHORT', 'LONG', 'NEUTRAL'));

        expect(result).toEqual({
            signal: 'NEUTRAL',
            confidence: 0,
            reason: 'Индикаторы дают противоположные сигналы',
        });
    });

    it('returns 33% confidence when one indicator supports a direction and two are neutral', () => {
        const result = calculateConsensus(makeAnalyses('NEUTRAL', 'NEUTRAL', 'SHORT'));

        expect(result.signal).toBe('SHORT');
        expect(result.confidence).toBe(33);
        expect(result.reason).toBe('Только Momentum 100 подтверждает SHORT');
    });

    it('returns NEUTRAL with 0% confidence when all indicators are neutral', () => {
        const result = calculateConsensus(makeAnalyses('NEUTRAL', 'NEUTRAL', 'NEUTRAL'));

        expect(result).toEqual({
            signal: 'NEUTRAL',
            confidence: 0,
            reason: 'Ни один индикатор не даёт сигнала',
        });
    });
});
