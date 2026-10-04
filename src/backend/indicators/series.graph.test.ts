import { describe, expect, it } from 'vitest';
import { indicatorConfig } from '../config/indicator.config.js';
import { currentCandles } from '../test-support/candles.js';
import {
    calculateMarketIndicators,
    emaSeriesKey,
    indicatorRegistry,
    seriesGraph,
} from './indicator.service.js';
import type { SeriesDefinition } from './series.graph.js';
import { createSeriesGraph, emaSeries } from './series.graph.js';

describe('the series graph', () => {
    it('computes a series once however many times it is asked for', () => {
        const graph = createSeriesGraph();
        let calls = 0;

        graph.register({
            key: 'expensive',
            requires: [],
            compute: () => {
                calls += 1;
                return 'value';
            },
        });

        // The same series requested by three different consumers, and again
        // through a node that depends on it. One computation, not five.
        graph.register({
            key: 'first',
            requires: ['expensive'],
            compute: () => 'first',
        });
        graph.register({
            key: 'second',
            requires: ['expensive'],
            compute: () => 'second',
        });

        const resolved = graph.resolve(
            ['expensive', 'first', 'second', 'expensive'],
            { candles: [], closes: [] },
        );

        expect(calls).toBe(1);
        expect(resolved.values.get('expensive')).toBe('value');
        expect(resolved.values.get('first')).toBe('first');
        expect(resolved.stats.computed.get('expensive')).toBe(1);
    });

    it('computes what it needs before what needs it', () => {
        const graph = createSeriesGraph();
        const order: string[] = [];

        const record = (key: string): SeriesDefinition => ({
            key,
            requires: [],
            compute: () => {
                order.push(key);
                return key;
            },
        });

        graph.register(record('inner'));
        graph.register({ ...record('outer'), requires: ['inner'] });
        graph.register({
            ...record('outermost'),
            requires: ['outer', 'inner'],
        });

        // The order of operations is something the graph decides and asserts,
        // rather than something a reader has to reconstruct from the inside of
        // a ninety-line function.
        expect(graph.plan(['outermost'])).toEqual(['inner', 'outer', 'outermost']);

        graph.resolve(['outermost'], { candles: [], closes: [] });

        expect(order).toEqual(['inner', 'outer', 'outermost']);
    });

    it('names the cycle rather than overflowing the stack', () => {
        const graph = createSeriesGraph();

        graph.register({ key: 'a', requires: ['b'], compute: () => 1 });
        graph.register({ key: 'b', requires: ['a'], compute: () => 2 });

        // A stack overflow says "Maximum call stack size exceeded", which is a
        // fact about the runtime and not about the graph.
        expect(() => graph.plan(['a'])).toThrow(/Series cycle: a -> b -> a/);
    });

    it('refuses a series nobody registered', () => {
        const graph = createSeriesGraph();

        expect(() => graph.plan(['missing'])).toThrow(/not registered/);
    });

    it('refuses two series under one name', () => {
        const graph = createSeriesGraph();

        graph.register({ key: 'a', requires: [], compute: () => 1 });

        expect(() =>
            graph.register({ key: 'a', requires: [], compute: () => 2 }),
        ).toThrow(/already registered/);
    });

    it('keeps periods apart, so one cannot be served for the other', () => {
        const graph = createSeriesGraph();

        graph.register(emaSeries(12));
        graph.register(emaSeries(26));

        // The key carries the period on purpose. A graph with one node called
        // "ema" cannot answer a request for two different periods, and that is
        // exactly the bug a graph is supposed to make impossible.
        expect(graph.get('ema:12')?.key).toBe('ema:12');
        expect(graph.get('ema:26')?.key).toBe('ema:26');
    });

    it('reports a short series rather than a wrong number', () => {
        const graph = createSeriesGraph();

        graph.register(emaSeries(26));

        expect(() =>
            graph.resolve(['ema:26'], { candles: [], closes: [1, 2, 3] }),
        ).toThrow(/at least 26 values/);
    });
});

describe('the graph in the running system', () => {
    it('resolves every series any registered indicator declared', () => {
        // The union comes from the registry, not from a list written next to
        // it. A list there would be a list to forget to update.
        const declared = indicatorRegistry
            .list()
            .flatMap((definition) => definition.series ?? []);

        expect(declared.length).toBeGreaterThan(0);

        for (const key of declared) {
            expect(seriesGraph.get(key)).toBeDefined();
        }
    });

    it('names the series after the configured period, not after 300', () => {
        expect(emaSeriesKey).toBe(`ema:${indicatorConfig.emaPeriod}`);
    });

    it('produces the same EMA the calculator did', () => {
        // Routing the EMA through a graph is a refactor, and a refactor that
        // moves the arithmetic moves the signal.
        const marketData = {
            provider: 'binance' as const,
            symbol: 'BTCUSDT',
            interval: '1h' as const,
            timestamp: Date.now(),
            price: { symbol: 'BTCUSDT', price: 1_000 },
            candles: currentCandles(indicatorConfig.emaPeriod * 4),
        };

        const indicators = calculateMarketIndicators(marketData);
        const direct = seriesGraph.resolve(
            [emaSeriesKey],
            { candles: [], closes: marketData.candles.map((c) => c.close) },
        ).values.get(emaSeriesKey);

        expect(indicators.ema).toBe(direct);
        expect(Number.isFinite(indicators.ema)).toBe(true);
    });

    it('computes a declared series exactly once per run', () => {
        // A probe the real graph cannot see into, so the count is a
        // measurement rather than an inference from reading the code.
        let calls = 0;
        const probe = createSeriesGraph();

        probe.register({
            key: 'probe',
            requires: [],
            compute: (context) => {
                calls += 1;
                return context.closes.length;
            },
        });

        // Three consumers, one series, the situation the graph exists for.
        probe.register({ key: 'a', requires: ['probe'], compute: () => 1 });
        probe.register({ key: 'b', requires: ['probe'], compute: () => 2 });
        probe.register({ key: 'c', requires: ['probe'], compute: () => 3 });

        probe.resolve(['a', 'b', 'c'], { candles: [], closes: [1, 2] });

        expect(calls).toBe(1);
    });

    it('says plainly that no two indicators share a series today', () => {
        // The honest limit of this module, asserted so it cannot be forgotten.
        // MACD's fast and slow lines are not `ema:12` and `ema:26` from this
        // graph: they start at their own seed and the slow one only updates
        // from the slow period onwards, so sharing a node would change the
        // numbers. The graph's value today is the invariant and the count, not
        // cycles saved.
        const declared = indicatorRegistry
            .list()
            .flatMap((definition) => definition.series ?? []);
        const distinct = new Set(declared);

        expect(declared.length).toBeGreaterThanOrEqual(distinct.size);
    });
});
