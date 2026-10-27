import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { candleFreshness, ResearchContext } from './research-context';

describe('research context contract', () => {
    it('ages the close of a bar rather than its opening time', () => {
        expect(candleFreshness(0, '1h', 3_600_000)).toEqual({ ageMs: 0 });
        expect(candleFreshness(0, '1h', 7_200_001)).toEqual({ ageMs: 3_600_001 });
        expect(candleFreshness(undefined, '1h', 10)).toBeNull();
    });
    it('does not invent provenance or probability and explains the HOLD limitation', () => {
        const html = renderToStaticMarkup(createElement(ResearchContext, {
            interval: '1h', timestamp: 10, lastBar: undefined, now: 20,
        }));
        for (const text of ['Источник и биржа: API не сообщает', 'API не сообщает stale/degraded', 'HOLD', 'не вероятность успеха', 'buy-and-hold', 'не подтверждено', 'Только для исследования']) {
            expect(html).toContain(text);
        }
        expect(html).toContain('aria-label="Контекст исследования и качество данных"');
    });
    it('keeps a directional signal alongside diagnostic unusable quality, without inventing a veto', () => {
        const html = renderToStaticMarkup(createElement(ResearchContext, {
            interval: '1h', timestamp: 20, lastBar: undefined, now: 60_010,
            direction: 'LONG',
            snapshot: { provider: 'bitget', symbol: 'ETHUSDT', interval: '1h', lastBarClosedAt: 10, stale: true, freshness: 'provider_failed' },
            explanation: { confidence: { model: 'wilson', meaning: 'Доля согласных весов', isProbabilityOfBeingRight: false }, quality: { usable: false, score: 0.2, worst: 'gaps', blockedBy: ['gaps'] } },
        }));
        for (const text of ['bitget', 'ETHUSDT', 'provider_failed', '1 мин', 'wilson', 'Причины непригодности: gaps', 'Худший фактор: gaps', 'Опубликованное направление: LONG', 'не блокирует публикацию направления автоматически']) expect(html).toContain(text);
    });
});
