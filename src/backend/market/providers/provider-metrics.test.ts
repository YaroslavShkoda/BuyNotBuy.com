import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MetricRegistry, useRegistry } from '../../observability/registry.js';
import {
    recordProviderError,
    recordProviderRequest,
    recordProviderRetry,
    resetProviderTelemetry,
} from './provider-telemetry.js';
import { publishProviderGauges } from './provider-metrics.js';
import { resetProviderTransport } from './provider-http.js';

/**
 * The catalogue is the promise, and this is the diffing.
 *
 * Ten provider names used to be written by hand in `api/lib/metrics.ts`, and the
 * closed catalogue disagreed with every one it mentioned: a counter where the
 * catalogue declares a gauge, a mean where it declares a distribution, and a
 * different name for the rate-limit counter. The list exists so the exposition can
 * be diffed against the promise — which was impossible while the names lived
 * anywhere else.
 */
describe('the provider metrics the catalogue promises', () => {
    let registry: MetricRegistry;

    beforeEach(() => {
        registry = new MetricRegistry();

        // The counters are written where the event happens, through
        // `currentRegistry()`, so the test has to install its own — otherwise it
        // writes into the live registry and reads an empty one of its own.
        useRegistry(registry);
        resetProviderTelemetry();
        resetProviderTransport('mock');
    });

    afterEach(() => {
        useRegistry(null);
    });

    it('publishes a counter for every call, labelled by venue and market', () => {
        // Counters are push-shaped: they mean something at the moment they happen,
        // so this is written where the call is made, not derived at scrape time.
        recordProviderRequest('mock', 'BTCUSDT', '/klines', 100, 200);
        recordProviderRequest('mock', 'ETHUSDT', '/klines', 4_000, 200);

        expect(registry.value('provider_requests_total', { provider: 'mock', market: 'BTCUSDT' })).toBe(1);
        expect(registry.value('provider_requests_total', { provider: 'mock', market: 'ETHUSDT' })).toBe(1);

        // Two markets, two series — the round-94 lesson: one flat number cannot say
        // which market is slow, and a label that makes the bare name unreadable
        // would have cost the promised name.
        expect(registry.value('provider_requests_total')).toBe(0);
    });

    it('publishes the latency as a distribution, because the tail is the point', () => {
        // The hand-written version published a mean and called it latency. The mean
        // hides the request somebody is sitting in front of, which is the whole
        // reason the catalogue declares a distribution here.
        recordProviderRequest('mock', 'BTCUSDT', '/klines', 100, 200);
        recordProviderRequest('mock', 'BTCUSDT', '/klines', 9_000, 200);

        const rendered = registry.render({ namespace: 'buynotbuy_' });

        expect(rendered).toMatch(/buynotbuy_provider_latency_count\{[^}]*\} 2/);
        expect(rendered).toMatch(/buynotbuy_provider_latency_sum\{[^}]*\} 9100/);
        expect(rendered).toMatch(/buynotbuy_provider_latency\{[^}]*quantile="0.9/);
    });

    it('publishes the derived gauges only when somebody looks', () => {
        // `binance` and not `mock`, because the publisher's pairs come from the
        // configured venues plus whatever the telemetry has seen. `mock` with no
        // recorded traffic is not a market anyone asked about, and asserting on it
        // here failed first time for exactly that reason — a test written against a
        // venue that does not exist proves nothing about the venues that do.
        //
        // A gauge is a statement about the present. Before the publisher runs there
        // is nothing to read, which is correct: the value at the last event is not
        // the current one.
        expect(registry.value('provider_health', { provider: 'binance', market: 'BTCUSDT' })).toBe(0);

        publishProviderGauges(registry);

        // `1`, not null: a gauge that is simply absent and a gauge that reads zero
        // are the same line to a scraper and opposite facts to an operator.
        expect(
            registry.value('provider_health', { provider: 'binance', market: 'BTCUSDT' }),
        ).toBe(1);
    });

    it('sets the circuit gauge as a gauge, which is why it cannot be a counter', () => {
        publishProviderGauges(registry);

        const rendered = registry.render({ namespace: 'buynotbuy_' });

        // A counter of something that is 1 or 0 would have to go backwards when the
        // breaker closes, and `rate()` on a falling counter is a negative slope that
        // looks like a bug in the dashboard and is a bug here.
        expect(rendered).toMatch(/# TYPE buynotbuy_provider_circuit_open gauge/);
    });

    it('reports the error rate of one market off another market', () => {
        recordProviderRequest('mock', 'BTCUSDT', '/klines', 100, 200);
        recordProviderRequest('mock', 'ETHUSDT', '/klines', 100, 200);
        recordProviderError('mock', 'BTCUSDT', '/klines');

        publishProviderGauges(registry);

        // One request and one error on BTCUSDT is a rate of **1**, and that is the
        // second time in this work I wrote 0.5 out of habit — the first was in round
        // 94, where two markets shared one denominator. The rate belongs to the
        // series that failed: BTCUSDT failed every call it made, ETHUSDT none.
        expect(
            registry.value('provider_error_rate', { provider: 'mock', market: 'BTCUSDT' }),
        ).toBe(1);
        expect(
            registry.value('provider_error_rate', { provider: 'mock', market: 'ETHUSDT' }),
        ).toBe(0);
    });

    it('counts retries under the name the catalogue declares', () => {
        recordProviderRetry('mock', 'BTCUSDT');

        // Declared `provider_retries`, published for years as
        // `provider_retries_total` from outside the registry. The name a dashboard
        // reads has changed, and it changed because the catalogue said so.
        expect(registry.value('provider_retries', { provider: 'mock', market: 'BTCUSDT' })).toBe(1);
    });
});

describe('the pairs the provider gauges publish', () => {
    let registry: MetricRegistry;

    beforeEach(() => {
        registry = new MetricRegistry();
        useRegistry(registry);
        resetProviderTelemetry();
        vi.resetModules();
    });

    it('publishes a venue only for the markets it serves', async () => {
        // **This is the finding, and it was mine.** The first version multiplied
        // venues by markets, so with `binance=BTCUSDT@1h;bitget=ETHUSDT@1h` it
        // published `provider_health{market="ETHUSDT",provider="binance"} 1` for a
        // venue that has never been asked about ETHUSDT — and read healthy, because
        // a venue nobody called is `degraded`, and degraded counts as available.
        //
        // An operator reading that concludes binance serves ETHUSDT.
        // Both settings, or neither: the pairs come from the markets that are
        // configured, so declaring the venue for a market the process does not
        // observe lists nothing — which is the same mistake as the one above, in
        // the other direction.
        vi.stubEnv('MARKET_SYMBOL', 'BTCUSDT');
        vi.stubEnv('MARKET_SYMBOLS', 'ETHUSDT');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT@1h;bitget=ETHUSDT@1h');

        const { publishProviderGauges: publish } = await import('./provider-metrics.js');

        publish(registry);

        const rendered = registry.render({ namespace: 'buynotbuy_' });

        expect(rendered).toContain(
            'buynotbuy_provider_health{market="ETHUSDT",provider="bitget"}',
        );
        expect(rendered).not.toContain(
            'buynotbuy_provider_health{market="ETHUSDT",provider="binance"}',
        );
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        useRegistry(null);
    });
});
