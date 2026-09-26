import { afterEach, describe, expect, it } from 'vitest';

import {
    getMetricsSnapshot,
    recordRequestFinished,
    recordRequestStarted,
    renderMetrics,
    resetMetrics,
} from './metrics.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

function fakeRequest(pattern: string | undefined): FastifyRequest {
    return {
        routeOptions: pattern === undefined ? undefined : { url: pattern },
    } as unknown as FastifyRequest;
}

function fakeReply(statusCode: number): FastifyReply {
    return { statusCode } as FastifyReply;
}

afterEach(() => {
    resetMetrics();
});

describe('metrics', () => {
    it('counts a request that finished', () => {
        const request = fakeRequest('/api/analysis');

        recordRequestStarted(request);
        recordRequestFinished(request, fakeReply(200));

        const snapshot = getMetricsSnapshot();

        expect(snapshot.requests).toBe(1);
        expect(snapshot.inFlight).toBe(0);
        expect(snapshot.failures).toBe(0);
    });

    it('shows a request that has not finished as in flight', () => {
        recordRequestStarted(fakeRequest('/api/market'));

        // A request that never answers is a stuck process, and silence is
        // the one thing a counter cannot show.
        expect(getMetricsSnapshot().inFlight).toBe(1);
    });

    it('counts a 4xx as a failure', () => {
        const request = fakeRequest('/api/analysis');

        recordRequestStarted(request);
        recordRequestFinished(request, fakeReply(400));

        expect(getMetricsSnapshot().failures).toBe(1);
    });

    it('does not count a 304 as a failure', () => {
        const request = fakeRequest('/api/analysis');

        recordRequestStarted(request);
        recordRequestFinished(request, fakeReply(304));

        // A conditional request answered from the client's cache is a success.
        expect(getMetricsSnapshot().failures).toBe(0);
    });

    it('groups by the route pattern, not the path that was requested', () => {
        // The raw path carries the symbol and the query, so using it would
        // create a permanent series per value and put user data in every
        // label.
        for (let i = 0; i < 3; i += 1) {
            recordRequestStarted(fakeRequest('/api/signal-history'));
        }

        expect(getMetricsSnapshot().byRoute.get('/api/signal-history')).toBe(3);
    });

    it('buckets by status class rather than by exact code', () => {
        recordRequestStarted(fakeRequest('/a'));
        recordRequestFinished(fakeRequest('/a'), fakeReply(404));
        recordRequestStarted(fakeRequest('/a'));
        recordRequestFinished(fakeRequest('/a'), fakeReply(500));

        expect(getMetricsSnapshot().byStatusClass.get('4xx')).toBe(1);
        expect(getMetricsSnapshot().byStatusClass.get('5xx')).toBe(1);
    });

    it('never lets the in-flight count go negative', () => {
        const request = fakeRequest('/api/analysis');

        recordRequestFinished(request, fakeReply(200));

        expect(getMetricsSnapshot().inFlight).toBe(0);
    });
});

describe('metrics exposition', () => {
    it('names the type of every series', () => {
        const text = renderMetrics();

        // A scrape with no TYPE line is a scrape a Prometheus server rejects.
        expect(text).toContain('# TYPE buynotbuy_requests_total counter');
        expect(text).toContain('# TYPE buynotbuy_requests_in_flight gauge');
    });

    it('reports uptime, because no failures means different things over time', () => {
        expect(renderMetrics()).toMatch(
            /^buynotbuy_uptime_seconds \d+$/m,
        );
    });

    it('escapes a quote in a label', () => {
        recordRequestStarted(fakeRequest('/api/"quoted"'));

        // An unescaped quote would end the label and turn the rest of the
        // line into a malformed series.
        expect(renderMetrics()).not.toContain('route="/api/"quoted""');
    });

    it('lists every counter it promises', () => {
        recordRequestStarted(fakeRequest('/api/analysis'));
        recordRequestFinished(fakeRequest('/api/analysis'), fakeReply(200));

        const text = renderMetrics();

        for (const name of [
            'buynotbuy_requests_total',
            'buynotbuy_request_failures_total',
            'buynotbuy_requests_in_flight',
            'buynotbuy_requests_by_route_total',
            'buynotbuy_requests_by_status_class_total',
        ]) {
            expect(text).toContain(name);
        }
    });
});
