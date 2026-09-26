import { describe, expect, it } from 'vitest';

import { getConfidenceWidth, getContextIndicators, getIndicatorValueText, getVoteSummary } from './signal-panel';

import type { IndicatorAnalysis, IndicatorKey } from '../types/analysis';

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

function makeVote(
    key: IndicatorKey,
    name: string,
    signal: IndicatorAnalysis['signal'],
): IndicatorAnalysis {
    return { key, name, signal, reason: `${name} ${signal}`, weight: signal === 'NEUTRAL' ? 0 : 1 };
}

describe('signal vote summary', () => {
    it('describes unanimous support', () => {
        const indicators = [
            makeVote('ema', 'EMA 300', 'LONG'),
            makeVote('stochastic', 'Стохастик', 'LONG'),
            makeVote('momentum', 'Momentum 100', 'LONG'),
        ];

        expect(getVoteSummary(indicators, 'LONG')).toBe('Все 3 индикатора поддерживают LONG');
    });

    it('describes partial support with an opposing vote', () => {
        const indicators = [
            makeVote('ema', 'EMA 300', 'LONG'),
            makeVote('stochastic', 'Стохастик', 'SHORT'),
            makeVote('momentum', 'Momentum 100', 'LONG'),
        ];

        expect(getVoteSummary(indicators, 'LONG')).toBe('2 из 3 индикаторов поддерживают LONG · 1 против');
    });

    it('uses singular verb and noun for a single supporting vote', () => {
        const indicators = [
            makeVote('ema', 'EMA 300', 'LONG'),
            makeVote('stochastic', 'Стохастик', 'NEUTRAL'),
            makeVote('momentum', 'Momentum 100', 'NEUTRAL'),
        ];

        expect(getVoteSummary(indicators, 'LONG')).toBe('1 из 3 индикаторов поддерживает LONG');
    });

    it('describes SHORT support', () => {
        const indicators = [
            makeVote('ema', 'EMA 300', 'SHORT'),
            makeVote('stochastic', 'Стохастик', 'SHORT'),
            makeVote('momentum', 'Momentum 100', 'LONG'),
        ];

        expect(getVoteSummary(indicators, 'SHORT')).toBe('2 из 3 индикаторов поддерживают SHORT · 1 против');
    });

    it('returns null for a NEUTRAL signal with opposing votes (backend reason already explains it)', () => {
        const indicators = [
            makeVote('ema', 'EMA 300', 'LONG'),
            makeVote('stochastic', 'Стохастик', 'SHORT'),
            makeVote('momentum', 'Momentum 100', 'NEUTRAL'),
        ];

        expect(getVoteSummary(indicators, 'NEUTRAL')).toBeNull();
    });

    it('returns null for all-neutral votes (backend reason already explains it)', () => {
        const indicators = [
            makeVote('ema', 'EMA 300', 'NEUTRAL'),
            makeVote('stochastic', 'Стохастик', 'NEUTRAL'),
            makeVote('momentum', 'Momentum 100', 'NEUTRAL'),
        ];

        expect(getVoteSummary(indicators, 'NEUTRAL')).toBeNull();
    });

    it('returns null for an empty indicator list', () => {
        expect(getVoteSummary([], 'LONG')).toBeNull();
    });
});

/**
 * Every value the panel renders, so a fixture cannot silently fall behind.
 *
 * `macdHistogram` is in dollars, not in a fraction. It used to be written as a
 * small fraction here, which is what let the currency/percentage mix-up stand:
 * the fixture agreed with the formatter's assumption instead of with what the
 * backend sends, so the test passed while the page reported "+1846%" for a
 * histogram of eighteen dollars. The values below are a real BTCUSDT reading.
 */
const FULL = {
    ema300: 82172.9,
    stochastic: 24.1,
    momentum: -2.68,
    atr: 0.00203,
    rsi: 48.5,
    macdHistogram: 18.46,
    price: 84120,
};

describe('indicator values survive a configurable period', () => {
    // The reason the panel matches on the key rather than the label. Under a
    // label match, changing the momentum period would blank this row, and
    // nothing would look broken — the number would simply stop being rendered.
    it('renders the momentum value whatever the period in the label', () => {
        // The label never reaches the formatter at all; the key decides.
        expect(getIndicatorValueText('momentum', FULL)).toBe('-2.68%');
    });

    it('renders every key', () => {
        const values = { ...FULL, ema300: 1234.5, stochastic: 42.125, momentum: -1.5 };

        // `maximumFractionDigits` is a ceiling, not a floor: 1234.5 is
        // rendered without a trailing zero rather than padded to two places.
        expect(getIndicatorValueText('ema', values)).toBe('$1,234.5');
        expect(getIndicatorValueText('stochastic', values)).toBe('42.13');
        expect(getIndicatorValueText('momentum', values)).toBe('-1.50%');
    });
});

describe('context indicators', () => {
    const periods = {
        ema: 300,
        stochastic: 100,
        momentum: 100,
        atr: 14,
        rsi: 14,
        macdFast: 12,
        macdSlow: 26,
        macdSignal: 9,
    };

    it('names the periods it was computed with', () => {
        // The label is a claim about the computation. A literal would go stale
        // the moment the period changed in the environment.
        expect(getContextIndicators(FULL, periods).map((row) => row.name)).toEqual([
            'ATR 14',
            'RSI 14',
            'MACD 12/26/9',
        ]);
    });

    it('follows a changed period', () => {
        const names = getContextIndicators(FULL, { ...periods, atr: 21 }).map(
            (row) => row.name,
        );

        expect(names[0]).toBe('ATR 21');
        expect(names[0]).not.toContain('ATR 14');
    });

    it('renders ATR unsigned and the MACD histogram signed', () => {
        const rows = getContextIndicators(FULL, periods);

        // A range is not above or below anything; a histogram direction is.
        expect(rows[0]?.value).toBe('0.20%');
        expect(rows[2]?.value).toBe('+0.022%');
    });

    it('reports the histogram as a share of price, not as dollars per cent', () => {
        // 18.46 dollars on an 84,120 dollar instrument is 0.022% of price. Scaled
        // without dividing it would read "+1846%", a number large enough to look
        // like a market event and which moves with the price of the instrument
        // rather than with the market: halve BTC and the reading halves, with
        // no change in what the two MACD lines are doing.
        const rows = getContextIndicators(FULL, periods);
        const value = Number((rows[2]?.value ?? '').replace('+', '').replace('%', ''));

        expect(Math.abs(value)).toBeLessThan(1);
        // Three places, because that is all the rendered reading carries: the
        // rendered number is rounded, and asking it to match to five would be
        // asserting on precision the page does not show.
        expect(value).toBeCloseTo((FULL.macdHistogram / FULL.price) * 100, 3);
    });

    it('keeps the histogram reading comparable across instruments', () => {
        // The same gap between the two lines, on a cheap coin, is a much larger
        // share of its price. Converting through the price is what makes the two
        // numbers mean the same thing; without it they are dollars per cent.
        const cheap = getContextIndicators(
            { ...FULL, price: 841.2, macdHistogram: 18.46 },
            periods,
        );

        expect(cheap[2]?.value).toBe('+2.194%');
    });

    it('carries no vote, so it cannot be mistaken for a second opinion', () => {
        // Nothing here is LONG/SHORT/NEUTRAL. These are measurements, and the
        // rows are rendered without the vote badge for that reason.
        for (const row of getContextIndicators(FULL, periods)) {
            expect(row).not.toHaveProperty('signal');
        }
    });
});
