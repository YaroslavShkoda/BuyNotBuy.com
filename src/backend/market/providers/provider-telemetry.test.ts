import { beforeEach, describe, expect, it } from 'vitest';

import {
    percentile,
    providerTelemetry,
    providerTelemetryAll,
    recordProviderCircuitOpen,
    recordProviderError,
    recordProviderRateLimited,
    recordProviderRequest,
    recordProviderRetry,
    resetProviderTelemetry,
} from './provider-telemetry.js';
import { marketConfig } from '../../config/market.config.js';

describe('provider latency telemetry', () => {
    beforeEach(() => {
        resetProviderTelemetry();
    });

    it('reports no traffic as null rather than as a perfect error rate', () => {
        const stats = providerTelemetry('binance', 'BTCUSDT');

        // Zero would be indistinguishable from "answered every call perfectly",
        // which is the reading that matters during an incident.
        expect(stats.errorRate).toBeNull();
        expect(stats.latencyP95Ms).toBeNull();
        expect(stats.meanLatencyMs).toBeNull();
    });

    it('counts requests, errors and retries separately', () => {
        recordProviderRequest('binance', 'BTCUSDT', '/klines', 100, 200);
        recordProviderRequest('binance', 'BTCUSDT', '/klines', 120, 200);
        recordProviderRequest('binance', 'BTCUSDT', '/klines', 4000, null);
        recordProviderError('binance', 'BTCUSDT', '/klines');
        recordProviderRetry('binance', 'BTCUSDT');
        recordProviderRateLimited('binance', 'BTCUSDT');
        recordProviderCircuitOpen('binance', 'BTCUSDT');

        const stats = providerTelemetry('binance', 'BTCUSDT');

        expect(stats.requests).toBe(3);
        expect(stats.failures).toBe(1);
        expect(stats.retries).toBe(1);
        expect(stats.rateLimits).toBe(1);
        expect(stats.circuitOpens).toBe(1);
        expect(stats.errorRate).toBeCloseTo(1 / 3, 10);
    });

    it('computes nearest-rank percentiles over the sample', () => {
        for (let index = 1; index <= 100; index += 1) {
            recordProviderRequest('binance', 'BTCUSDT', '/klines', index, 200);
        }

        const stats = providerTelemetry('binance', 'BTCUSDT');

        expect(stats.latencyP50Ms).toBe(50);
        expect(stats.latencyP95Ms).toBe(95);
        expect(stats.latencyP99Ms).toBe(99);
        expect(stats.meanLatencyMs).toBeCloseTo(50.5, 10);
    });

    it('drops the oldest samples so a long-lived process stays bounded', () => {
        const size = marketConfig.providerLatencySampleSize;

        for (let index = 0; index < size + 50; index += 1) {
            recordProviderRequest('binance', 'BTCUSDT', '/klines', 1_000, 200);
        }

        // The window has to keep describing the present, which is why the new
        // sample evicts the old one rather than the buffer refusing it: a full
        // reservoir that stops accepting would freeze the percentiles at the
        // values from before the incident that filled it.
        expect(providerTelemetry('binance', 'BTCUSDT').latencySamples).toBe(size);

        recordProviderRequest('binance', 'BTCUSDT', '/klines', 9_000, 200);

        const stats = providerTelemetry('binance', 'BTCUSDT');

        expect(stats.latencySamples).toBe(size);
        // The outlier is accepted (one sample in 512 is 0.2%, far below p50)
        // and the window is unchanged. Both halves matter: a reservoir that
        // rejected it would report a healthy venue during the very incident it
        // exists to reveal.
        expect(stats.lastLatencyMs).toBe(9_000);
        expect(stats.latencyP50Ms).toBe(1_000);
    });

    it('ignores a non-finite latency rather than poisoning the percentiles', () => {
        recordProviderRequest('binance', 'BTCUSDT', '/klines', 100, 200);
        recordProviderRequest('binance', 'BTCUSDT', '/klines', Number.NaN, null);

        const stats = providerTelemetry('binance', 'BTCUSDT');

        // The request is still counted — it happened — but a NaN in the sample
        // would sort unpredictably and turn every percentile into NaN, which is
        // exactly the value a graph cannot draw and an alert cannot compare.
        expect(stats.requests).toBe(2);
        expect(stats.latencySamples).toBe(1);
        expect(stats.latencyP95Ms).toBe(100);
    });

    it('keeps venues in separate series', () => {
        recordProviderRequest('binance', 'BTCUSDT', '/klines', 100, 200);
        recordProviderError('bitget', 'BTCUSDT', '/klines');

        expect(providerTelemetry('binance', 'BTCUSDT').failures).toBe(0);
        expect(providerTelemetry('bitget', 'BTCUSDT').failures).toBe(1);
        expect(providerTelemetryAll().map((entry) => entry.provider)).toEqual([
            'binance',
            'bitget',
        ]);
    });

    it('counts errors even for a venue that never recorded a request', () => {
        recordProviderError('bitget', 'BTCUSDT', '/tickers');

        // Zero requests over one error is a real ratio of infinity, and the
        // null guard is what keeps it from being rendered as NaN.
        expect(providerTelemetry('bitget', 'BTCUSDT').errorRate).toBeNull();
    });
});

describe('percentile', () => {
    it('is null for an empty sample', () => {
        expect(percentile([], 95)).toBeNull();
    });

    it('does not interpolate', () => {
        // Nearest rank, so "p50 of [1,2,3,4]" is 2 and not 2.5. These numbers
        // end up on an alert threshold, where "at least half the calls were
        // this slow" is the only claim worth making.
        expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    });

    it('handles a single sample', () => {
        expect(percentile([7], 99)).toBe(7);
    });

    it('leaves the input untouched', () => {
        const samples = [3, 1, 2];

        percentile(samples, 50);

        expect(samples).toEqual([3, 1, 2]);
    });
});

describe('latency over one market, on a venue serving two', () => {
    beforeEach(() => {
        resetProviderTelemetry();
    });

    it('keeps a fast market\'s p95 out of a slow market\'s', () => {
        // **This is the item.** One series per venue, so
        // `buynotbuy_provider_latency_p95_ms{provider="binance"}` was the 95th
        // percentile of both markets together: a normal 4-second ETHUSDT response
        // pushed BTCUSDT's p95 over the alert threshold, and the operator reading
        // the line could not tell which series caused the crossing.
        for (let sample = 0; sample < 100; sample += 1) {
            recordProviderRequest('binance', 'BTCUSDT', '/klines', 100, 200);
            recordProviderRequest('binance', 'ETHUSDT', '/klines', 4_000, 200);
        }

        expect(providerTelemetry('binance', 'BTCUSDT').latencyP95Ms).toBe(100);
        expect(providerTelemetry('binance', 'ETHUSDT').latencyP95Ms).toBe(4_000);
    });

    it('counts one market\'s errors off another market\'s error rate', () => {
        recordProviderRequest('binance', 'BTCUSDT', '/klines', 100, 200);
        recordProviderRequest('binance', 'ETHUSDT', '/klines', 100, 200);
        recordProviderError('binance', 'ETHUSDT', '/klines');

        // Under a shared series BTCUSDT would have read 0.5 — a venue failing half
        // the time on paper, while one of its two series was perfect. And ETHUSDT
        // reads 1, not 0.5: the error rate belongs to the series that failed, not
        // to the venue that hosts it.
        expect(providerTelemetry('binance', 'BTCUSDT').errorRate).toBe(0);
        expect(providerTelemetry('binance', 'ETHUSDT').errorRate).toBe(1);
    });

    it('forgets a whole venue without a market, because a bare delete would now miss', () => {
        // The reset is the silent half of this change. Keys carry a market, so
        // `series.delete(provider)` matches nothing — a reset that looks like it
        // worked and a suite that passes for the wrong reason.
        recordProviderRequest('binance', 'BTCUSDT', '/klines', 100, 200);
        recordProviderRequest('binance', 'ETHUSDT', '/klines', 100, 200);

        resetProviderTelemetry('binance');

        expect(providerTelemetry('binance', 'BTCUSDT').requests).toBe(0);
        expect(providerTelemetry('binance', 'ETHUSDT').requests).toBe(0);
    });
});
