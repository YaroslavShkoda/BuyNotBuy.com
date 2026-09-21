import { describe, expect, it } from 'vitest';
import { calculateSignal } from './signal.service';

describe('calculateSignal', () => {
    it('returns LONG with 100% confidence when both indicators are LONG', () => {
        const result = calculateSignal(82000, {
            ema300: 78000,
            stochastic: 10,
        });

        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBe(100);
        expect(result.reason).toBe(
            'EMA 300 и Стохастик подтверждают LONG',
        );
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
        ]);
    });

    it('returns SHORT with 100% confidence when both indicators are SHORT', () => {
        const result = calculateSignal(75000, {
            ema300: 78000,
            stochastic: 90,
        });

        expect(result.signal).toBe('SHORT');
        expect(result.confidence).toBe(100);
        expect(result.reason).toBe(
            'EMA 300 и Стохастик подтверждают SHORT',
        );
        expect(result.indicators).toEqual([
            {
                name: 'EMA 300',
                signal: 'SHORT',
                reason: 'Цена ниже EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'SHORT',
                reason: 'Стохастик выше 80',
            },
        ]);
    });

    it('returns LONG with 50% confidence when only EMA is LONG', () => {
        const result = calculateSignal(82000, {
            ema300: 78000,
            stochastic: 50,
        });

        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBe(50);
        expect(result.reason).toBe(
            'Только EMA 300 подтверждает LONG',
        );
        expect(result.indicators).toEqual([
            {
                name: 'EMA 300',
                signal: 'LONG',
                reason: 'Цена выше EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'NEUTRAL',
                reason: 'Стохастик находится в нейтральной зоне',
            },
        ]);
    });

    it('returns SHORT with 50% confidence when only EMA is SHORT', () => {
        const result = calculateSignal(75000, {
            ema300: 78000,
            stochastic: 50,
        });

        expect(result.signal).toBe('SHORT');
        expect(result.confidence).toBe(50);
        expect(result.reason).toBe(
            'Только EMA 300 подтверждает SHORT',
        );
        expect(result.indicators).toEqual([
            {
                name: 'EMA 300',
                signal: 'SHORT',
                reason: 'Цена ниже EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'NEUTRAL',
                reason: 'Стохастик находится в нейтральной зоне',
            },
        ]);
    });

    it('returns LONG with 50% confidence when only Stochastic is LONG', () => {
        const result = calculateSignal(78000, {
            ema300: 78000,
            stochastic: 10,
        });

        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBe(50);
        expect(result.reason).toBe(
            'Только Стохастик подтверждает LONG',
        );
        expect(result.indicators).toEqual([
            {
                name: 'EMA 300',
                signal: 'NEUTRAL',
                reason: 'Цена находится на уровне EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'LONG',
                reason: 'Стохастик ниже 15',
            },
        ]);
    });

    it('returns SHORT with 50% confidence when only Stochastic is SHORT', () => {
        const result = calculateSignal(78000, {
            ema300: 78000,
            stochastic: 90,
        });

        expect(result.signal).toBe('SHORT');
        expect(result.confidence).toBe(50);
        expect(result.reason).toBe(
            'Только Стохастик подтверждает SHORT',
        );
        expect(result.indicators).toEqual([
            {
                name: 'EMA 300',
                signal: 'NEUTRAL',
                reason: 'Цена находится на уровне EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'SHORT',
                reason: 'Стохастик выше 80',
            },
        ]);
    });

    it('returns NEUTRAL with 50% confidence when indicators conflict', () => {
        const result = calculateSignal(82000, {
            ema300: 78000,
            stochastic: 90,
        });

        expect(result.signal).toBe('NEUTRAL');
        expect(result.confidence).toBe(50);
        expect(result.reason).toBe(
            'Индикаторы дают противоположные сигналы',
        );
        expect(result.indicators).toEqual([
            {
                name: 'EMA 300',
                signal: 'LONG',
                reason: 'Цена выше EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'SHORT',
                reason: 'Стохастик выше 80',
            },
        ]);
    });

    it('returns NEUTRAL with 50% confidence when indicators conflict in the opposite direction', () => {
        const result = calculateSignal(75000, {
            ema300: 78000,
            stochastic: 10,
        });

        expect(result.signal).toBe('NEUTRAL');
        expect(result.confidence).toBe(50);
        expect(result.reason).toBe(
            'Индикаторы дают противоположные сигналы',
        );
        expect(result.indicators).toEqual([
            {
                name: 'EMA 300',
                signal: 'SHORT',
                reason: 'Цена ниже EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'LONG',
                reason: 'Стохастик ниже 15',
            },
        ]);
    });

    it('returns NEUTRAL with 0% confidence when both indicators are neutral', () => {
        const result = calculateSignal(78000, {
            ema300: 78000,
            stochastic: 50,
        });

        expect(result.signal).toBe('NEUTRAL');
        expect(result.confidence).toBe(0);
        expect(result.reason).toBe(
            'Ни один индикатор не даёт сигнала',
        );
        expect(result.indicators).toEqual([
            {
                name: 'EMA 300',
                signal: 'NEUTRAL',
                reason: 'Цена находится на уровне EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'NEUTRAL',
                reason: 'Стохастик находится в нейтральной зоне',
            },
        ]);
    });
});
