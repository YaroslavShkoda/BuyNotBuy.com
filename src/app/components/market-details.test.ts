import { describe, expect, it } from 'vitest';

import { describeDivergence, getStochasticZone } from './market-details';

import type { DivergenceAnalysis } from '../types/analysis';

describe('stochastic zone presentation', () => {
    it('marks overbought and oversold zones', () => {
        expect(getStochasticZone(80)).toBe('Зона перекупленности');
        expect(getStochasticZone(95)).toBe('Зона перекупленности');
        expect(getStochasticZone(15)).toBe('Зона перепроданности');
        expect(getStochasticZone(5)).toBe('Зона перепроданности');
    });

    it('marks the neutral range', () => {
        expect(getStochasticZone(50)).toBe('Нейтральный диапазон');
        expect(getStochasticZone(79.99)).toBe('Нейтральный диапазон');
        expect(getStochasticZone(15.01)).toBe('Нейтральный диапазон');
    });
});

describe('divergence presentation', () => {
    it('reports the absence of divergence honestly', () => {
        const presentation = describeDivergence({ bullish: null, bearish: null });

        expect(presentation.label).toBe('Дивергенция не обнаружена');
        expect(presentation.tone).toBe('neutral');
        expect(presentation.detail).toBeNull();
    });

    it('describes a bullish divergence with actual price and momentum points', () => {
        const divergence: DivergenceAnalysis = {
            bullish: {
                type: 'BULLISH',
                previous: { index: 10, confirmedAtIndex: 14, age: 26, price: 67_400, momentum: -1.2 },
                current: { index: 20, confirmedAtIndex: 24, age: 16, price: 66_900, momentum: -0.9 },
            },
            bearish: null,
        };

        const presentation = describeDivergence(divergence);

        expect(presentation.label).toBe('Бычья дивергенция');
        expect(presentation.tone).toBe('positive');
        expect(presentation.detail).toBe(
            'Цена: $67,400 → $66,900 (ниже) · Momentum: -1.2% → -0.9% (выше) · Подтверждена 16 свечей назад',
        );
    });

    it('agrees with the confirmation age of the current pivot', () => {
        const divergence: DivergenceAnalysis = {
            bullish: {
                type: 'BULLISH',
                previous: { index: 1, confirmedAtIndex: 3, age: 40, price: 60_000, momentum: -2 },
                current: { index: 2, confirmedAtIndex: 4, age: 1, price: 59_000, momentum: -1 },
            },
            bearish: null,
        };

        expect(describeDivergence(divergence).detail).toContain(
            'Подтверждена 1 свеча назад',
        );
    });

    it('agrees the counted noun with the age in every plural form', () => {
        // The count sits in front of "назад", so it takes the genitive like any
        // other counted noun. The teens are the trap: the last digit says 1, 2
        // and 4, and all three are wrong in 11, 12 and 14.
        const ages = [
            { age: 1, noun: 'свеча' },
            { age: 2, noun: 'свечи' },
            { age: 4, noun: 'свечи' },
            { age: 5, noun: 'свечей' },
            { age: 11, noun: 'свечей' },
            { age: 12, noun: 'свечей' },
            { age: 14, noun: 'свечей' },
            { age: 21, noun: 'свеча' },
            { age: 22, noun: 'свечи' },
            { age: 25, noun: 'свечей' },
            { age: 53, noun: 'свечи' },
            { age: 101, noun: 'свеча' },
            { age: 111, noun: 'свечей' },
        ];

        for (const { age, noun } of ages) {
            const divergence: DivergenceAnalysis = {
                bullish: {
                    type: 'BULLISH',
                    previous: { index: 1, confirmedAtIndex: 3, age: 40, price: 60_000, momentum: -2 },
                    current: { index: 2, confirmedAtIndex: 4, age, price: 59_000, momentum: -1 },
                },
                bearish: null,
            };

            expect(describeDivergence(divergence).detail).toContain(
                `Подтверждена ${age} ${noun} назад`,
            );
        }
    });

    it('describes a bearish divergence with actual price and momentum points', () => {
        const divergence: DivergenceAnalysis = {
            bullish: null,
            bearish: {
                type: 'BEARISH',
                previous: { index: 5, confirmedAtIndex: 9, age: 3, price: 70_000, momentum: 1.5 },
                current: { index: 15, confirmedAtIndex: 19, age: 3, price: 71_200, momentum: 0.9 },
            },
        };

        const presentation = describeDivergence(divergence);

        expect(presentation.label).toBe('Медвежья дивергенция');
        expect(presentation.tone).toBe('negative');
        expect(presentation.detail).toBe(
            'Цена: $70,000 → $71,200 (выше) · Momentum: +1.5% → +0.9% (ниже) · Подтверждена 3 свечи назад',
        );
    });

    it('prefers the bullish divergence when both are present', () => {
        const divergence: DivergenceAnalysis = {
            bullish: {
                type: 'BULLISH',
                previous: { index: 1, confirmedAtIndex: 3, age: 0, price: 60_000, momentum: -10 },
                current: { index: 2, confirmedAtIndex: 4, age: 0, price: 59_000, momentum: -5 },
            },
            bearish: {
                type: 'BEARISH',
                previous: { index: 3, confirmedAtIndex: 5, age: 0, price: 70_000, momentum: 100 },
                current: { index: 4, confirmedAtIndex: 6, age: 0, price: 71_000, momentum: 50 },
            },
        };

        expect(describeDivergence(divergence).label).toBe('Бычья дивергенция');
    });
});
