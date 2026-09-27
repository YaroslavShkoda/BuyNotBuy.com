import { observabilityConfig } from '../../config/observability.config.js';
import { signalHistoryBacklog } from '../../history/signal-history.service.js';
import { indicatorVoteBacklog } from '../../indicators/performance/indicator-performance.service.js';
import { configuredMarketVenues } from '../../market/market.provider.js';
import { venueHealth } from '../../market/providers/provider-http.js';
import { providerTelemetryAll } from '../../market/providers/provider-telemetry.js';
import { currentRegistry } from '../../observability/registry.js';

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

    // The write backlogs, because an unwritten record is invisible everywhere
    // else. A drop counter that only ever appears in the log line emitted by
    // the next failure is not a metric: once writes recover, a service that
    // lost a hundred hours looks exactly as healthy as one that lost none,
    // and the stability summary it serves reads as a long unbroken run.
    for (const [name, state] of [
        ['signal_history', signalHistoryBacklog()],
        ['indicator_vote', indicatorVoteBacklog()],
    ] as const) {
        lines.push(
            '',
            `# HELP buynotbuy_write_backlog_${name}_buffered Records held for a retry.`,
            `# TYPE buynotbuy_write_backlog_${name}_buffered gauge`,
            `buynotbuy_write_backlog_${name}_buffered ${state.buffered}`,
            '',
            `# HELP buynotbuy_write_backlog_${name}_dropped_total Records lost to a full buffer.`,
            `# TYPE buynotbuy_write_backlog_${name}_dropped_total counter`,
            `buynotbuy_write_backlog_${name}_dropped_total ${state.dropped}`,
        );
    }

    // Provider telemetry. The venue is the only label, and the venue list is
    // the configured one — bounded by configuration, not by traffic, so this
    // cannot grow a series per request the way a path or a symbol would.
    //
    // Rendered for every configured venue even before the first call, so a
    // scraper sees a zero rather than a gap. A gap and a zero look identical on
    // a graph and mean opposite things: "no traffic" and "no data".
    for (const venue of new Set([
        ...configuredMarketVenues(),
        ...providerTelemetryAll().map((entry) => entry.provider),
    ])) {
        const stats = providerTelemetryAll().find(
            (entry) => entry.provider === venue,
        );
        const healthState = venueHealth(venue);
        const label = `{provider="${escapeLabel(venue)}"}`;

        lines.push(
            '',
            `# HELP buynotbuy_provider_requests_total Provider calls attempted.`,
            '# TYPE buynotbuy_provider_requests_total counter',
            `buynotbuy_provider_requests_total${label} ${stats?.requests ?? 0}`,
            '',
            '# HELP buynotbuy_provider_errors_total Provider calls that failed.',
            '# TYPE buynotbuy_provider_errors_total counter',
            `buynotbuy_provider_errors_total${label} ${stats?.failures ?? 0}`,
            '',
            '# HELP buynotbuy_provider_rate_limits_total Rate-limit responses received.',
            '# TYPE buynotbuy_provider_rate_limits_total counter',
            `buynotbuy_provider_rate_limits_total${label} ${stats?.rateLimits ?? 0}`,
            '',
            '# HELP buynotbuy_provider_retries_total Provider calls retried.',
            '# TYPE buynotbuy_provider_retries_total counter',
            `buynotbuy_provider_retries_total${label} ${stats?.retries ?? 0}`,
            '',
            '# HELP buynotbuy_provider_circuit_open_total Calls refused by an open breaker.',
            '# TYPE buynotbuy_provider_circuit_open_total counter',
            `buynotbuy_provider_circuit_open_total${label} ${stats?.circuitOpens ?? 0}`,
            '',
            '# HELP buynotbuy_provider_latency_ms Provider call latency percentiles over the recent sample.',
            '# TYPE buynotbuy_provider_latency_ms gauge',
            `buynotbuy_provider_latency_ms${label} ${stats?.lastLatencyMs ?? 0}`,
            `buynotbuy_provider_latency_p50_ms${label} ${stats?.latencyP50Ms ?? 0}`,
            `buynotbuy_provider_latency_p95_ms${label} ${stats?.latencyP95Ms ?? 0}`,
            `buynotbuy_provider_latency_p99_ms${label} ${stats?.latencyP99Ms ?? 0}`,
            '',
            '# HELP buynotbuy_provider_error_rate Share of provider calls that failed, in [0, 1].',
            '# TYPE buynotbuy_provider_error_rate gauge',
            // No traffic is rendered as 0 rather than as a NaN, which is what an
            // absent sample would produce and which no scraper can graph.
            `buynotbuy_provider_error_rate${label} ${stats?.errorRate ?? 0}`,
            '',
            '# HELP buynotbuy_provider_health 1 when the venue can be asked, 0 when it cannot.',
            '# TYPE buynotbuy_provider_health gauge',
            `buynotbuy_provider_health${label} ${healthState.available ? 1 : 0}`,
            '',
            '# HELP buynotbuy_provider_consecutive_failures Failures since the last success.',
            '# TYPE buynotbuy_provider_consecutive_failures gauge',
            `buynotbuy_provider_consecutive_failures${label} ${healthState.consecutiveFailures}`,
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

    // The metrics the roadmap named, from the registry that records them at the
    // call sites. Appended rather than merged into the blocks above, because
    // these have declared kinds and a test that holds the registry against the
    // list of names; the hand-written lines above carry extra series this
    // project found worth having, which is a different thing from the promise.
    lines.push(roadmapExposition());

    return lines.join('\n');
}

/** The thirteen promised metrics, in the registry's own text exposition. */
function roadmapExposition(): string {
    return currentRegistry().render({ namespace: 'buynotbuy_' });
}
