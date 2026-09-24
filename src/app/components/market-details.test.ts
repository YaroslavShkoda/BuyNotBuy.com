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
                previous: { index: 10, price: 67_400, momentum: -120 },
                current: { index: 20, price: 66_900, momentum: -85 },
            },
            bearish: null,
        };

        const presentation = describeDivergence(divergence);

        expect(presentation.label).toBe('Бычья дивергенция');
        expect(presentation.tone).toBe('positive');
        expect(presentation.detail).toBe(
            'Цена: $67,400 → $66,900 (ниже) · Momentum: -120 → -85 (выше)',
        );
    });

    it('describes a bearish divergence with actual price and momentum points', () => {
        const divergence: DivergenceAnalysis = {
            bullish: null,
            bearish: {
                type: 'BEARISH',
                previous: { index: 5, price: 70_000, momentum: 150 },
                current: { index: 15, price: 71_200, momentum: 90 },
            },
        };

        const presentation = describeDivergence(divergence);

        expect(presentation.label).toBe('Медвежья дивергенция');
        expect(presentation.tone).toBe('negative');
        expect(presentation.detail).toBe(
            'Цена: $70,000 → $71,200 (выше) · Momentum: +150 → +90 (ниже)',
        );
    });

    it('prefers the bullish divergence when both are present', () => {
        const divergence: DivergenceAnalysis = {
            bullish: {
                type: 'BULLISH',
                previous: { index: 1, price: 60_000, momentum: -10 },
                current: { index: 2, price: 59_000, momentum: -5 },
            },
            bearish: {
                type: 'BEARISH',
                previous: { index: 3, price: 70_000, momentum: 100 },
                current: { index: 4, price: 71_000, momentum: 50 },
            },
        };

        expect(describeDivergence(divergence).label).toBe('Бычья дивергенция');
    });
});
