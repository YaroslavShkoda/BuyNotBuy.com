import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
    METRIC_COUNTERS,
    METRIC_DISTRIBUTIONS,
    METRIC_GAUGES,
    METRIC_KIND,
    METRIC_NAMES,
    metricKind,
} from './metrics.js';
import {
    CATALOGUE_BY_NAME,
    declareMetric,
    labelValue,
    METRIC_CATALOGUE,
    MetricRegistry,
    seriesKey,
} from './registry.js';

describe('the metrics the roadmap named are the metrics we publish', () => {
    const EXPECTED = [
        'provider_requests_total',
        'provider_errors_total',
        'provider_latency',
        'provider_rate_limits',
        'provider_circuit_open',
        'market_cache_hits',
        'market_cache_misses',
        'market_stale_served',
        'indicator_calculation_duration',
        'signal_generation_total',
        'signal_changes_total',
        'database_query_duration',
        'backtest_duration',
        'strategy_decision_write_failures',
        'market_cycle_failures',
        // Declared because the exposition already published them from outside the
        // registry, under names and kinds the catalogue disagreed with. The list is
        // the promise; these were in the exposition and not in it.
        'provider_retries',
        'provider_error_rate',
        'provider_health',
        'provider_consecutive_failures',
        'metric_series_limit',
        // Absent from the promise until round 107, which is how they stayed out
        // of the catalogue: the list is closed, and a name nothing declared could
        // not be diffed against anything. These four were being exposed by hand
        // the whole time.
        'write_backlog_signal_history_buffered',
        'write_backlog_signal_history_dropped_total',
        'write_backlog_indicator_vote_buffered',
        'write_backlog_indicator_vote_dropped_total',
    ];

    it('publishes exactly those, in one list, without duplicates', () => {
        // The list is closed on purpose: a metric added later still has to be
        // declared, so the exposition can be diffed against the promise.
        expect([...METRIC_NAMES].sort()).toEqual([...EXPECTED].sort());
    });

    it('categorises every one of them exactly once', () => {
        expect(METRIC_COUNTERS.length + METRIC_GAUGES.length + METRIC_DISTRIBUTIONS.length).toBe(
            EXPECTED.length,
        );

        for (const name of METRIC_NAMES) {
            const kinds = [
                METRIC_COUNTERS as readonly string[],
                METRIC_GAUGES as readonly string[],
                METRIC_DISTRIBUTIONS as readonly string[],
            ].filter((group) => group.includes(name));

            expect(kinds).toHaveLength(1);
        }
    });

    it('makes provider_circuit_open a gauge, because a circuit is open or shut', () => {
        // A reader who sees "17" on a counter named circuit_open has been told
        // the circuit is seventeen times open, which is not a thing.
        expect(METRIC_KIND.provider_circuit_open).toBe('gauge');
    });

    it('makes the four latencies distributions, not single numbers', () => {
        // A single number on provider_latency is the average, and the average
        // is the number that hides the request somebody is waiting on.
        for (const name of METRIC_DISTRIBUTIONS) {
            expect(METRIC_KIND[name]).toBe('distribution');
        }
    });

    it('refuses to name a kind for a metric that does not exist', () => {
        expect(metricKind('a_metric_nobody_declared')).toBeNull();
    });

    it('documents every metric, and documents each one once', () => {
        expect(CATALOGUE_BY_NAME.size).toBe(METRIC_NAMES.length);

        for (const entry of METRIC_CATALOGUE) {
            // A name is a promise and a description is the contract behind it.
            // Without it, market_stale_served is a number nobody can interpret:
            // per request or per candle, and is one stale hour a problem?
            expect(entry.description.length).toBeGreaterThan(20);
            expect(METRIC_KIND[entry.name as never]).toBe(entry.kind);
        }
    });

    it('refuses a metric nobody declared rather than inventing a kind for it', () => {
        expect(() => declareMetric('a_metric_nobody_declared')).toThrow(/не объявлена/);
        expect(declareMetric('provider_requests_total').name).toBe(
            'provider_requests_total',
        );
    });
});

describe('a counter that can go down has lost the only property that mattered', () => {
    it('refuses a negative increment', () => {
        const registry = new MetricRegistry();

        // rate() over the result is what every dashboard does, and a counter
        // that went backwards produces a negative rate that looks like a bug
        // in the dashboard and is a bug here.
        expect(() => registry.counter('provider_requests_total', -1)).toThrow(
            /не может уменьшаться/,
        );
    });

    it('refuses to count something that is not a counter', () => {
        const registry = new MetricRegistry();

        expect(() => registry.counter('provider_circuit_open')).toThrow(/не счётчик/);
        expect(() => registry.gauge('provider_requests_total', 1)).toThrow(/не измеритель/);
        expect(() => registry.observe('provider_requests_total', 1)).toThrow(
            /не распределение/,
        );
    });

    it('adds up across labels rather than overwriting', () => {
        const registry = new MetricRegistry();

        registry.counter('provider_errors_total', 1, { provider: 'binance' });
        registry.counter('provider_errors_total', 1, { provider: 'binance' });
        registry.counter('provider_errors_total', 1, { provider: 'bybit' });

        expect(registry.value('provider_errors_total', { provider: 'binance' })).toBe(2);
        expect(registry.value('provider_errors_total', { provider: 'bybit' })).toBe(1);
    });

    it('lets a gauge go both ways, which is the point of it', () => {
        const registry = new MetricRegistry();

        registry.gauge('provider_circuit_open', 1, { provider: 'binance' });
        registry.gauge('provider_circuit_open', 0, { provider: 'binance' });

        expect(registry.value('provider_circuit_open', { provider: 'binance' })).toBe(0);
    });
});

describe('the same scrape of an unchanged system is byte-identical', () => {
    it('renders label sets in sorted order, not insertion order', () => {
        const registry = new MetricRegistry();

        registry.counter('provider_requests_total', 1, {
            symbol: 'BTCUSDT',
            provider: 'binance',
        });
        registry.counter('provider_requests_total', 1, {
            provider: 'binance',
            symbol: 'BTCUSDT',
        });

        // Prometheus treats a series whose labels differ in order as a
        // different series, so a registry that rendered insertion order would
        // invent a new series on every process start.
        expect(
            seriesKey('provider_requests_total', { provider: 'binance', symbol: 'BTCUSDT' }),
        ).toBe(seriesKey('provider_requests_total', { symbol: 'BTCUSDT', provider: 'binance' }));
    });

    it('produces the same text twice for the same writes', () => {
        const build = () => {
            const registry = new MetricRegistry();

            registry.counter('provider_requests_total', 3, { provider: 'binance' });
            registry.gauge('provider_circuit_open', 0, { provider: 'binance' });
            registry.observe('provider_latency', 12, { provider: 'binance' });

            return registry.render();
        };

        expect(build()).toBe(build());
    });
});

describe('a label value cannot inject a line into somebody else metric', () => {
    it('rejects a quote, a newline and a backslash', () => {
        // Anything in a label lands verbatim in the exposition. A symbol name
        // that could smuggle a line in is a way to publish metrics that are
        // not this service's.
        expect(() => labelValue('symbol', 'BTC"USDT')).toThrow();
        expect(() => labelValue('symbol', 'BTC\nfake_total 999')).toThrow();
        expect(() => labelValue('symbol', 'BTC\\USDT')).toThrow();
    });

    it('accepts the characters real symbols, venues and operations use', () => {
        for (const value of ['BTCUSDT', 'bybit-spot', 'market.candles', '1d', 'ema/200']) {
            expect(() => labelValue('operation', value)).not.toThrow();
        }
    });

    it('gives the same verdict for the same value, every time', () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 12 }), (value) => {
                let accepted = true;

                try {
                    labelValue('x', value);
                } catch {
                    accepted = false;
                }

                const again = (() => {
                    try {
                        labelValue('x', value);
                        return true;
                    } catch {
                        return false;
                    }
                })();

                expect(again).toBe(accepted);
            }),
            { numRuns: 100 },
        );
    });
});

describe('the exposition answers the questions it is scraped for', () => {
    it('reports a metric at zero before anything has happened', () => {
        const rendered = new MetricRegistry().render();

        // A metric that only appears after the first event cannot answer "has
        // this ever happened", and "missing" and "zero" are different answers.
        expect(rendered).toContain('provider_requests_total 0');
        expect(rendered).toContain('market_stale_served 0');
        expect(rendered).toContain('provider_circuit_open 0');
    });

    it('declares the type of every metric, so a scraper knows what it is reading', () => {
        const rendered = new MetricRegistry().render();

        expect(rendered).toContain('# TYPE provider_requests_total counter');
        expect(rendered).toContain('# TYPE provider_circuit_open gauge');
        expect(rendered).toContain('# TYPE provider_latency summary');
    });

    it('publishes the tail of a latency, not just the middle', () => {
        const registry = new MetricRegistry();

        for (let index = 0; index < 200; index += 1) {
            registry.observe('provider_latency', 20, { provider: 'binance' });
        }

        for (let index = 0; index < 5; index += 1) {
            registry.observe('provider_latency', 40_000, { provider: 'binance' });
        }

        const rendered = registry.render();

        // One brace group, never two: a scraper that cannot read a line
        // rejects the whole document, not just that line.
        expect(rendered).toMatch(/provider_latency\{provider="binance",quantile="0\.5"\} 20/);
        expect(rendered).toMatch(/provider_latency\{provider="binance",quantile="1"\} 40000/);
        expect(rendered).toMatch(/provider_latency_count\{provider="binance"\} 205/);
        expect(rendered).not.toMatch(/\}\s*\{/);
    });

    it('keeps the sum of everything ever observed, not just the window', () => {
        const registry = new MetricRegistry();

        for (let index = 0; index < 5000; index += 1) {
            registry.observe('database_query_duration', 10, { operation: 'history.list' });
        }

        // The reservoir forgets samples so it cannot be made to grow, but a
        // _sum that forgot with it would make the rate of a metric a function
        // of how much had been written since the last thousand samples.
        expect(registry.render()).toMatch(/database_query_duration_sum\{operation="history\.list"\} 50000/);
        expect(registry.render()).toMatch(/database_query_duration_count\{operation="history\.list"\} 5000/);
    });

    it('prefixes every name when a namespace is given', () => {
        const registry = new MetricRegistry();

        registry.counter('signal_generation_total', 1);

        expect(registry.render({ namespace: 'bnb_' })).toContain('bnb_signal_generation_total 1');
    });

    it('never renders a value that is not finite', () => {
        const registry = new MetricRegistry();

        registry.counter('signal_changes_total', 2);

        expect(registry.render()).not.toMatch(/NaN|Infinity/);
    });
});
