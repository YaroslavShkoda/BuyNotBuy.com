import { describe, expect, it } from 'vitest';
import { intervalLinks } from './interval-switcher';

describe('the interval switcher links', () => {
    it('keeps the scroll position when a timeframe is switched', () => {
        // Next.js Link scrolls to the top of the page when the target Page is
        // not visible in the viewport, and a timeframe switcher lives next to
        // a chart the reader has usually scrolled down to. Every link must
        // carry `scroll: false`, or the switch throws the reader to the header.
        const options = intervalLinks('BTCUSDT', '1h');

        expect(options).toHaveLength(4);
        expect(options.every((option) => option.scroll === false)).toBe(true);
    });

    it('targets the current market with one link per supported interval', () => {
        const options = intervalLinks('ETHUSDT', '4h');

        expect(options.map((option) => option.href)).toEqual([
            '/market/ETHUSDT?interval=15m',
            '/market/ETHUSDT?interval=1h',
            '/market/ETHUSDT?interval=4h',
            '/market/ETHUSDT?interval=1d',
        ]);
    });

    it('labels the links the way the chart names its timeframes', () => {
        const options = intervalLinks('BTCUSDT', '1h');

        expect(options.map((option) => option.label)).toEqual(['15м', '1ч', '4ч', '1д']);
    });

    it('marks the requested interval as the only active one', () => {
        const options = intervalLinks('SOLUSDT', '15m');

        expect(options.filter((option) => option.active).map((option) => option.value)).toEqual([
            '15m',
        ]);
    });
});
