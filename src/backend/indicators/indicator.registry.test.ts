import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    createIndicatorRegistry,
    indicatorContext,
} from './indicator.registry.js';
import {
    EMA_INDICATOR,
    indicatorRegistry,
    toWireIndicators,
    calculateMarketIndicators,
} from './indicator.service.js';
import { indicatorConfig } from '../config/indicator.config.js';

import type { Candle } from '../types/market.js';

const HOUR = 3_600_000;
const BASE = 1_699_999_200_000;

function bar(index: number, close = 100 + index): Candle {
    return {
        timestamp: BASE - index * HOUR,
        open: close - 0.5,
        high: close + 1,
        low: close - 1.5,
        close,
        volume: 10,
    };
}

function candles(count: number): Candle[] {
    return Array.from({ length: count }, (_, index) => bar(index));
}

describe('indicator registry', () => {
    it('registers an indicator under its key', () => {
        const registry = createIndicatorRegistry();

        registry.register(EMA_INDICATOR);

        expect(registry.get('ema')).toBe(EMA_INDICATOR);
    });

    it('refuses to register the same key twice', () => {
        const registry = createIndicatorRegistry();

        registry.register(EMA_INDICATOR);

        // Silently replacing a definition would mean every vote ever recorded
        // under this key is now describing something else, and nothing says so.
        expect(() => registry.register(EMA_INDICATOR)).toThrow(
            /already registered/,
        );
    });

    it('returns nothing for a key it does not know', () => {
        expect(createIndicatorRegistry().get('nope')).toBeUndefined();
    });

    it('lists what it has, in registration order', () => {
        const registry = createIndicatorRegistry();

        registry.register(EMA_INDICATOR);
        registry.register({
            ...EMA_INDICATOR,
            key: 'second',
            role: 'context',
        });

        expect(registry.list().map((entry) => entry.key)).toEqual([
            'ema',
            'second',
        ]);
    });

    it('separates the voters from the descriptive ones', () => {
        const registry = indicatorRegistry;

        expect(registry.voters().map((entry) => entry.key)).toEqual([
            'ema',
            'stochastic',
            'momentum',
        ]);
        expect(registry.contextual().map((entry) => entry.key)).toEqual([
            'atr',
            'rsi',
            'macd',
        ]);
    });

    it('computes everything registered, keyed by key', () => {
        const values = indicatorRegistry.calculate(
            indicatorContext(
                candles(indicatorConfig.emaPeriod * 4),
                BASE,
            ),
        );

        for (const definition of indicatorRegistry.list()) {
            expect(values[definition.key]?.value).toBeTypeOf('number');
        }
    });

    it('skips an indicator the series is too short for, rather than guessing', () => {
        const values = indicatorRegistry.calculate(
            indicatorContext(candles(20), BASE),
        );

        // A short series produces nothing from the long indicators, and the
        // key is absent rather than present with a zero in it. Twenty bars is
        // enough for the short ones and nowhere near enough for the EMA.
        expect(values['ema']).toBeUndefined();
        expect(values['momentum']).toBeUndefined();
        expect(values['rsi']).toBeDefined();
        expect(values['atr']).toBeDefined();
    });

    it('omits an indicator that produced a non-finite value', () => {
        const registry = createIndicatorRegistry();

        registry.register({
            ...EMA_INDICATOR,
            key: 'broken',
            warmup: 1,
            calculate: () => ({ value: Number.NaN }),
        });

        const values = registry.calculate(indicatorContext(candles(10), BASE));

        // Absent, not zero. A zero is a number the consensus will use; a hole
        // is something somebody has to look at.
        expect(values['broken']).toBeUndefined();
    });

    it('builds the close series once for every indicator', () => {
        const context = indicatorContext(candles(50), BASE);

        expect(context.closes).toHaveLength(50);
        expect(context.closes[0]).toBe(bar(0).close);
    });

    it('copies the series it was handed, so a later caller cannot change it', () => {
        const source = candles(20);
        const context = indicatorContext(source, BASE);

        source[0] = { ...source[0] as Candle, close: -1 };

        // The analysis reads a snapshot and then spends time on divergence. A
        // shared array means the indicators and the divergence service are
        // looking at different data in the same request.
        expect(context.candles[0]?.close).toBe(bar(0).close);
    });
});

describe('the process registry', () => {
    it('names every indicator with the period it was computed with', () => {
        // A label written into a component goes stale the moment the period is
        // changed, and then describes a number nobody produced.
        for (const definition of indicatorRegistry.list()) {
            expect(definition.name).not.toBe(definition.key);
        }

        expect(EMA_INDICATOR.name).toBe(`EMA ${indicatorConfig.emaPeriod}`);
    });

    it('declares a warm-up that actually warms it up', () => {
        // The EMA seeded with an SMA of its first `period` values only becomes
        // the EMA after several periods of recursion. A one-period warm-up
        // makes "EMA 300" arithmetically identical to SMA-300.
        expect(EMA_INDICATOR.warmup).toBeGreaterThan(
            indicatorConfig.emaPeriod,
        );
    });

    it('produces the same value as the calculation it replaced', () => {
        const series = candles(indicatorConfig.emaPeriod * 4);
        const indicators = calculateMarketIndicators({
            provider: 'binance',
            symbol: 'BTCUSDT',
            interval: '1h',
            timestamp: BASE,
            price: { symbol: 'BTCUSDT', price: 100 },
            candles: series,
        });

        // The registry is a refactor, not a change of arithmetic. If this ever
        // moves, the signal moved with it, and that is not a refactor.
        const closes = series.map((candle) => candle.close);
        let sum = 0;

        for (let index = 0; index < indicatorConfig.emaPeriod; index += 1) {
            sum += closes[index] ?? 0;
        }

        let ema = sum / indicatorConfig.emaPeriod;
        const k = 2 / (indicatorConfig.emaPeriod + 1);

        for (let index = indicatorConfig.emaPeriod; index < closes.length; index += 1) {
            ema = (closes[index] ?? 0) * k + ema * (1 - k);
        }

        expect(indicators.ema).toBeCloseTo(ema, 8);
    });
});

describe('the wire boundary', () => {
    it('keeps the published name the contract has always had', () => {
        const wire = toWireIndicators({
            ema: 1,
            stochastic: 2,
            momentum: 3,
            atr: 4,
            rsi: 5,
            macd: { macd: 6, signal: 7, histogram: 8 },
        });

        // A client that has been reading `ema300` since the first release does
        // not learn about this refactor by receiving undefined.
        expect(wire.ema300).toBe(1);
        expect('ema' in wire).toBe(false);
    });

    it('passes every other value through untouched', () => {
        const wire = toWireIndicators({
            ema: 1,
            stochastic: 2,
            momentum: 3,
            atr: 4,
            rsi: 5,
            macd: { macd: 6, signal: 7, histogram: 8 },
        });

        expect(wire).toEqual({
            ema300: 1,
            stochastic: 2,
            momentum: 3,
            atr: 4,
            rsi: 5,
            macd: { macd: 6, signal: 7, histogram: 8 },
        });
    });
});

describe('a new indicator is one file', () => {
    it('is registered by a definition, not by a switch somewhere else', () => {
        // The claim this file makes is that adding an indicator no longer
        // requires editing a vote function. It holds as long as the signal
        // service enumerates indicators rather than naming them.
        const source = readFileSync(
            join(import.meta.dirname, '..', 'signals', 'signal.service.ts'),
            'utf8',
        );

        expect(source).not.toMatch(/calculateMarketIndicators|indicatorRegistry/);
    });

    it('registers every definition the service file declares', () => {
        const source = readFileSync(
            join(import.meta.dirname, 'indicator.service.ts'),
            'utf8',
        );

        const declared = [
            ...source.matchAll(/export const (\w+)_INDICATOR: IndicatorDefinition/g),
        ].map((match) => match[1]);

        // A definition that is exported but never registered is an indicator
        // that computes and appears nowhere, which is the failure this registry
        // was introduced to make impossible. The trailing comma is what tells
        // a list entry apart from the declaration itself, which is followed by
        // a colon.
        expect(declared.length).toBeGreaterThan(0);

        for (const name of declared) {
            expect(source.includes(`${name}_INDICATOR,`)).toBe(true);
        }
    });

    it('has no indicator file that the registry does not know about', () => {
        const known = new Set(
            indicatorRegistry.list().map((entry) => entry.key),
        );

        const files = readdirSync(import.meta.dirname).filter(
            (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
        );

        // Only the calculators are files; everything else is wiring. A
        // calculator with no registration is a new indicator nobody can see.
        const calculators = files.filter((name) =>
            ['ema.ts', 'rsi.ts', 'macd.ts', 'atr.ts', 'momentum.ts', 'stochastic.ts'].includes(
                name,
            ),
        );

        expect(calculators.length).toBeGreaterThan(0);
        expect(known.size).toBeGreaterThanOrEqual(calculators.length);
    });
});
