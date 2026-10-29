import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SnapshotStrip } from './snapshot-strip';

describe('snapshot strip', () => {
    it('keeps unknown metadata unknown rather than declaring a fresh source', () => {
        const html = renderToStaticMarkup(createElement(SnapshotStrip, { label: 'График', now: 60_000 }));
        expect(html).toContain('API не сообщает');
        expect(html).not.toContain('data-freshness="fresh"');
        expect(html).not.toContain('binance');
    });
    it('shows actual venue and age of the closed bar independently of page time', () => {
        const html = renderToStaticMarkup(createElement(SnapshotStrip, {
            label: 'График', now: 120_010,
            snapshot: { provider: 'bitget', symbol: 'ETHUSDT', interval: '1h', lastBarClosedAt: 10, stale: true, freshness: 'provider_failed' },
        }));
        for (const value of ['bitget', 'ETHUSDT', '1h', '2 мин', 'provider_failed', 'повтор после сбоя', '1970-01-01T00:00:00.010Z']) expect(html).toContain(value);
        expect(html).not.toContain('data-freshness="fresh"');
    });
    it('labels each degraded state without changing its API meaning', () => {
        for (const freshness of ['fresh', 'stale', 'partially_available'] as const) {
            const html = renderToStaticMarkup(createElement(SnapshotStrip, {
                label: 'Анализ', now: 0,
                snapshot: { provider: 'binance', symbol: 'BTCUSDT', interval: '4h', lastBarClosedAt: 0, stale: freshness === 'stale', freshness },
            }));
            expect(html).toContain(`data-freshness="${freshness}"`);
            expect(html).toContain('Анализ');
        }
    });
});
