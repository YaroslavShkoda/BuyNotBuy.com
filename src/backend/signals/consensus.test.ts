import { describe, expect, it } from 'vitest';

import { calculateConsensus } from './consensus';

describe('calculateConsensus', () => {
    it('returns LONG with 100% confidence when all indicators are LONG', () => {
        const result = calculateConsensus([
            {
                name: 'EMA 300',
                signal: 'LONG',
                reason: 'Цена выше EMA 300',
            },
            {
                name: 'Stochastic',
                signal: 'LONG',
                reason: 'Стохастик ниже 15',
            },
            {
                name: 'Momentum',
                signal: 'LONG',
                reason: 'Momentum положительный',
            },
            {
                name: 'Divergence',
                signal: 'LONG',
                reason: 'Обнаружена bullish divergence',
            },
        ]);

        expect(result).toEqual({
            signal: 'LONG',
            confidence: 100,
            reason: 'EMA 300 и Stochastic и Momentum и Divergence подтверждают LONG',
        });
    });

    it('returns SHORT with 100% confidence when all indicators are SHORT', () => {
        const result = calculateConsensus([
            {
                name: 'EMA 300',
                signal: 'SHORT',
                reason: 'Цена ниже EMA 300',
            },
            {
                name: 'Stochastic',
                signal: 'SHORT',
                reason: 'Стохастик выше 80',
            },
            {
                name: 'Momentum',
                signal: 'SHORT',
                reason: 'Momentum отрицательный',
            },
            {
                name: 'Divergence',
                signal: 'SHORT',
                reason: 'Обнаружена bearish divergence',
            },
        ]);

        expect(result).toEqual({
            signal: 'SHORT',
            confidence: 100,
            reason: 'EMA 300 и Stochastic и Momentum и Divergence подтверждают SHORT',
        });
    });

    it('returns LONG with 50% confidence when LONG indicators and neutral indicators have no conflict', () => {
        const result = calculateConsensus([
            {
                name: 'EMA 300',
                signal: 'LONG',
                reason: 'Цена выше EMA 300',
            },
            {
                name: 'Stochastic',
                signal: 'LONG',
                reason: 'Стохастик ниже 15',
            },
            {
                name: 'Momentum',
                signal: 'NEUTRAL',
                reason: 'Momentum нейтрален',
            },
        ]);

        expect(result).toEqual({
            signal: 'LONG',
            confidence: 50,
            reason: 'Только EMA 300 и Stochastic подтверждают LONG',
        });
    });

    it('returns SHORT with 50% confidence when SHORT indicators and neutral indicators have no conflict', () => {
        const result = calculateConsensus([
            {
                name: 'EMA 300',
                signal: 'SHORT',
                reason: 'Цена ниже EMA 300',
            },
            {
                name: 'Stochastic',
                signal: 'SHORT',
                reason: 'Стохастик выше 80',
            },
            {
                name: 'Momentum',
                signal: 'NEUTRAL',
                reason: 'Momentum нейтрален',
            },
        ]);

        expect(result).toEqual({
            signal: 'SHORT',
            confidence: 50,
            reason: 'Только EMA 300 и Stochastic подтверждают SHORT',
        });
    });

    it('returns NEUTRAL when LONG and SHORT indicators conflict', () => {
        const result = calculateConsensus([
            {
                name: 'EMA 300',
                signal: 'LONG',
                reason: 'Цена выше EMA 300',
            },
            {
                name: 'Stochastic',
                signal: 'LONG',
                reason: 'Стохастик ниже 15',
            },
            {
                name: 'Momentum',
                signal: 'SHORT',
                reason: 'Momentum отрицательный',
            },
            {
                name: 'Divergence',
                signal: 'SHORT',
                reason: 'Обнаружена bearish divergence',
            },
        ]);

        expect(result).toEqual({
            signal: 'NEUTRAL',
            confidence: 50,
            reason: 'Индикаторы дают противоположные сигналы',
        });
    });

    it('returns NEUTRAL with 0% confidence when all indicators are neutral', () => {
        const result = calculateConsensus([
            {
                name: 'EMA 300',
                signal: 'NEUTRAL',
                reason: 'Цена находится на уровне EMA 300',
            },
            {
                name: 'Stochastic',
                signal: 'NEUTRAL',
                reason: 'Стохастик находится в нейтральной зоне',
            },
        ]);

        expect(result).toEqual({
            signal: 'NEUTRAL',
            confidence: 0,
            reason: 'Ни один индикатор не даёт сигнала',
        });
    });
});
