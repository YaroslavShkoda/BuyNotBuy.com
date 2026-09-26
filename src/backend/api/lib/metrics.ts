import { observabilityConfig } from '../../config/observability.config.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Counters and gauges for the process, rendered in the Prometheus text format.
 *
 * Deliberately not a client library: the only thing this service needs to
 * answer is "is it alive, is it ready, how is it doing", and a dependency that
 * outlives that need is one more thing to keep patched.
 *
 * Every series is a plain number in a map. There is no label set to bound,
 * because there is nothing to label: the interesting dimensions (per route,
 * per status) are counted under a name that the route table itself already
 * bounds. That is the cheapest way to make unbounded cardinality structurally
 * impossible rather than merely unlikely.
 */
export interface MetricsSnapshot {
    requests: number;
    failures: number;
    inFlight: number;
    startedAt: number;
    byRoute: Map<string, number>;
    byStatusClass: Map<string, number>;
}

function emptySnapshot(): MetricsSnapshot {
    return {
        requests: 0,
        failures: 0,
        inFlight: 0,
        startedAt: Date.now(),
        byRoute: new Map(),
        byStatusClass: new Map(),
    };
}

const snapshot: MetricsSnapshot = emptySnapshot();

/**
 * Route label for a request.
 *
 * The raw path is never used: it contains the symbol and the query, so every
 * distinct value would create a permanent series and every label would carry
 * user data into the metrics store. The matched route pattern is already
 * bounded by the number of routes.
 */
function routeLabel(request: FastifyRequest): string {
    // `routeOptions.url` is the matched pattern. It is undefined only before
    // routing has run, which cannot happen inside a counted request.
    const pattern = request.routeOptions?.url;

    if (typeof pattern !== 'string' || pattern === '') {
        return 'unmatched';
    }

    return pattern;
}

export function recordRequestStarted(request: FastifyRequest): void {
    snapshot.inFlight += 1;
    snapshot.requests += 1;
    snapshot.byRoute.set(routeLabel(request), (snapshot.byRoute.get(routeLabel(request)) ?? 0) + 1);
}

export function recordRequestFinished(
    request: FastifyRequest,
    reply: FastifyReply,
): void {
    snapshot.inFlight = Math.max(0, snapshot.inFlight - 1);

    if (reply.statusCode >= 400) {
        snapshot.failures += 1;
    }

    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;

    snapshot.byStatusClass.set(
        statusClass,
        (snapshot.byStatusClass.get(statusClass) ?? 0) + 1,
    );
}

export function getMetricsSnapshot(): MetricsSnapshot {
    return snapshot;
}

export function resetMetrics(): void {
    const startedAt = snapshot.startedAt;

    Object.assign(snapshot, emptySnapshot(), { startedAt });
}

function escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Prometheus text exposition.
 *
 * The uptime is included because "no requests have failed" means something
 * quite different after one second than after a week, and a metrics endpoint
 * without it makes that difference invisible.
 */
export function renderMetrics(): string {
    const now = Date.now();
    const uptimeSeconds = Math.max(0, Math.round((now - snapshot.startedAt) / 1000));
    const lines: string[] = [
        '# HELP buynotbuy_uptime_seconds Seconds since the process started.',
        '# TYPE buynotbuy_uptime_seconds gauge',
        `buynotbuy_uptime_seconds ${uptimeSeconds}`,
        '',
        '# HELP buynotbuy_requests_total Requests received.',
        '# TYPE buynotbuy_requests_total counter',
        `buynotbuy_requests_total ${snapshot.requests}`,
        '',
        '# HELP buynotbuy_request_failures_total Requests answered with a 4xx or 5xx.',
        '# TYPE buynotbuy_request_failures_total counter',
        `buynotbuy_request_failures_total ${snapshot.failures}`,
        '',
        '# HELP buynotbuy_requests_in_flight Requests currently being handled.',
        '# TYPE buynotbuy_requests_in_flight gauge',
        `buynotbuy_requests_in_flight ${snapshot.inFlight}`,
        '',
        '# HELP buynotbuy_requests_by_route_total Requests per route pattern.',
        '# TYPE buynotbuy_requests_by_route_total counter',
    ];

    for (const [route, count] of snapshot.byRoute) {
        lines.push(
            `buynotbuy_requests_by_route_total{route="${escapeLabel(route)}"} ${count}`,
        );
    }

    lines.push(
        '',
        '# HELP buynotbuy_requests_by_status_class_total Requests by response status class.',
        '# TYPE buynotbuy_requests_by_status_class_total counter',
    );

    for (const [statusClass, count] of snapshot.byStatusClass) {
        lines.push(
            `buynotbuy_requests_by_status_class_total{status="${escapeLabel(statusClass)}"} ${count}`,
        );
    }

    // The limit is reported so a reader can see whether the route table has
    // outgrown what the endpoint is prepared to keep.
    lines.push(
        '',
        '# HELP buynotbuy_metric_series_limit Maximum distinct series kept per group.',
        '# TYPE buynotbuy_metric_series_limit gauge',
        `buynotbuy_metric_series_limit ${observabilityConfig.metricLabelLimit}`,
        '',
    );

    return lines.join('\n');
}
