import { describe, expect, it } from 'vitest';

import { calculateSignal } from './signal.service';

describe('calculateSignal', () => {
    it('maps positive Momentum to LONG', () => {
        const result = calculateSignal(100, {
            ema300: 100,
            stochastic: 50,
            momentum: 0.01,
        });

        expect(result.indicators[2]).toEqual({
            name: 'Momentum 100',
            signal: 'LONG',
            reason: 'Momentum выше 0',
        });
        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBe(33);
    });

    it('maps negative Momentum to SHORT', () => {
        const result = calculateSignal(100, {
            ema300: 100,
            stochastic: 50,
            momentum: -0.01,
        });

        expect(result.indicators[2]).toEqual({
            name: 'Momentum 100',
            signal: 'SHORT',
            reason: 'Momentum ниже 0',
        });
        expect(result.signal).toBe('SHORT');
        expect(result.confidence).toBe(33);
    });

    it('maps zero Momentum to NEUTRAL', () => {
        const result = calculateSignal(100, {
            ema300: 100,
            stochastic: 50,
            momentum: 0,
        });

        expect(result.indicators[2]).toEqual({
            name: 'Momentum 100',
            signal: 'NEUTRAL',
            reason: 'Momentum равен 0',
        });
        expect(result.signal).toBe('NEUTRAL');
        expect(result.confidence).toBe(0);
    });

    it('includes EMA, Stochastic and Momentum in the signal indicator list', () => {
        const result = calculateSignal(80_000, {
            ema300: 78_000,
            stochastic: 10,
            momentum: 20,
        });

        expect(result.indicators).toEqual([
            {
                name: 'EMA 300',
                signal: 'LONG',
                reason: 'Цена выше EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'LONG',
                reason: 'Стохастик ниже 15',
            },
            {
                name: 'Momentum 100',
                signal: 'LONG',
                reason: 'Momentum выше 0',
            },
        ]);
    });

    it('returns LONG with 100% confidence when all three indicators are LONG', () => {
        const result = calculateSignal(80_000, {
            ema300: 78_000,
            stochastic: 10,
            momentum: 20,
        });

        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBe(100);
    });

    it('returns SHORT with 100% confidence when all three indicators are SHORT', () => {
        const result = calculateSignal(75_000, {
            ema300: 78_000,
            stochastic: 90,
            momentum: -20,
        });

        expect(result.signal).toBe('SHORT');
        expect(result.confidence).toBe(100);
    });

    it('returns LONG with 67% confidence for two LONG signals against one SHORT', () => {
        const result = calculateSignal(80_000, {
            ema300: 78_000,
            stochastic: 10,
            momentum: -20,
        });

        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBe(67);
    });

    it('returns SHORT with 67% confidence for two SHORT signals against one LONG', () => {
        const result = calculateSignal(75_000, {
            ema300: 78_000,
            stochastic: 90,
            momentum: 20,
        });

        expect(result.signal).toBe('SHORT');
        expect(result.confidence).toBe(67);
    });

    it('keeps an equal LONG and SHORT split NEUTRAL when the third signal is neutral', () => {
        const result = calculateSignal(80_000, {
            ema300: 78_000,
            stochastic: 90,
            momentum: 0,
        });

        expect(result.signal).toBe('NEUTRAL');
        expect(result.confidence).toBe(0);
    });
});
