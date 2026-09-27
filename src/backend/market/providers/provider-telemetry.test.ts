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
        const stats = providerTelemetry('binance');

        // Zero would be indistinguishable from "answered every call perfectly",
        // which is the reading that matters during an incident.
        expect(stats.errorRate).toBeNull();
        expect(stats.latencyP95Ms).toBeNull();
        expect(stats.meanLatencyMs).toBeNull();
    });

    it('counts requests, errors and retries separately', () => {
        recordProviderRequest('binance', '/klines', 100, 200);
        recordProviderRequest('binance', '/klines', 120, 200);
        recordProviderRequest('binance', '/klines', 4000, null);
        recordProviderError('binance', '/klines');
        recordProviderRetry('binance');
        recordProviderRateLimited('binance');
        recordProviderCircuitOpen('binance');

        const stats = providerTelemetry('binance');

        expect(stats.requests).toBe(3);
        expect(stats.failures).toBe(1);
        expect(stats.retries).toBe(1);
        expect(stats.rateLimits).toBe(1);
        expect(stats.circuitOpens).toBe(1);
        expect(stats.errorRate).toBeCloseTo(1 / 3, 10);
    });

    it('computes nearest-rank percentiles over the sample', () => {
        for (let index = 1; index <= 100; index += 1) {
            recordProviderRequest('binance', '/klines', index, 200);
        }

        const stats = providerTelemetry('binance');

        expect(stats.latencyP50Ms).toBe(50);
        expect(stats.latencyP95Ms).toBe(95);
        expect(stats.latencyP99Ms).toBe(99);
        expect(stats.meanLatencyMs).toBeCloseTo(50.5, 10);
    });

    it('drops the oldest samples so a long-lived process stays bounded', () => {
        const size = marketConfig.providerLatencySampleSize;

        for (let index = 0; index < size + 50; index += 1) {
            recordProviderRequest('binance', '/klines', 1_000, 200);
        }

        // The window has to keep describing the present, which is why the new
        // sample evicts the old one rather than the buffer refusing it: a full
        // reservoir that stops accepting would freeze the percentiles at the
        // values from before the incident that filled it.
        expect(providerTelemetry('binance').latencySamples).toBe(size);

        recordProviderRequest('binance', '/klines', 9_000, 200);

        const stats = providerTelemetry('binance');

        expect(stats.latencySamples).toBe(size);
        // The outlier is accepted (one sample in 512 is 0.2%, far below p50)
        // and the window is unchanged. Both halves matter: a reservoir that
        // rejected it would report a healthy venue during the very incident it
        // exists to reveal.
        expect(stats.lastLatencyMs).toBe(9_000);
        expect(stats.latencyP50Ms).toBe(1_000);
    });

    it('ignores a non-finite latency rather than poisoning the percentiles', () => {
        recordProviderRequest('binance', '/klines', 100, 200);
        recordProviderRequest('binance', '/klines', Number.NaN, null);

        const stats = providerTelemetry('binance');

        // The request is still counted — it happened — but a NaN in the sample
        // would sort unpredictably and turn every percentile into NaN, which is
        // exactly the value a graph cannot draw and an alert cannot compare.
        expect(stats.requests).toBe(2);
        expect(stats.latencySamples).toBe(1);
        expect(stats.latencyP95Ms).toBe(100);
    });

    it('keeps venues in separate series', () => {
        recordProviderRequest('binance', '/klines', 100, 200);
        recordProviderError('bitget', '/klines');

        expect(providerTelemetry('binance').failures).toBe(0);
        expect(providerTelemetry('bitget').failures).toBe(1);
        expect(providerTelemetryAll().map((entry) => entry.provider)).toEqual([
            'binance',
            'bitget',
        ]);
    });

    it('counts errors even for a venue that never recorded a request', () => {
        recordProviderError('bitget', '/tickers');

        // Zero requests over one error is a real ratio of infinity, and the
        // null guard is what keeps it from being rendered as NaN.
        expect(providerTelemetry('bitget').errorRate).toBeNull();
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
