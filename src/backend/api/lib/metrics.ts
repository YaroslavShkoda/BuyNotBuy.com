import { observabilityConfig } from '../../config/observability.config.js';
import { signalHistoryBacklog } from '../../history/signal-history.service.js';
import { indicatorVoteBacklog } from '../../indicators/performance/indicator-performance.service.js';
import { marketConfig } from '../../config/market.config.js';
import { configuredMarketVenues } from '../../market/market.provider.js';
import { venueHealthSummary } from '../../market/providers/provider-http.js';
import {
    providerTelemetry,
    providerTelemetryAll,
} from '../../market/providers/provider-telemetry.js';
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
export interface HttpMetricsSnapshot {
    requests: number;
    failures: number;
    inFlight: number;
    startedAt: number;
    byRoute: Map<string, number>;
    byStatusClass: Map<string, number>;
}

function emptySnapshot(): HttpMetricsSnapshot {
    return {
        requests: 0,
        failures: 0,
        inFlight: 0,
        startedAt: Date.now(),
        byRoute: new Map(),
        byStatusClass: new Map(),
    };
}

const snapshot: HttpMetricsSnapshot = emptySnapshot();

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

export function getMetricsSnapshot(): HttpMetricsSnapshot {
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

    /**
 * Every configured venue/market pair, plus any pair telemetry has seen.
 *
 * The configured pairs come first and are always present, so a market that has
 * never been called renders as a zero rather than as a gap. The telemetry pairs
 * catch a market that was called and is no longer configured — which should not
 * happen, and if it does, hiding it would be worse than showing it.
 */
function venueMarketPairs(): [string, string][] {
    const pairs = new Map<string, [string, string]>();

    for (const venue of configuredMarketVenues()) {
        for (const market of marketConfig.symbols) {
            pairs.set(`${venue}:${market}`, [venue, market]);
        }
    }

    for (const entry of providerTelemetryAll()) {
        pairs.set(`${entry.provider}:${entry.market}`, [entry.provider, entry.market]);
    }

    return [...pairs.values()];
}

// Provider telemetry. Labelled by **venue and market**.
    //
    // The venue alone was enough while there was one market, and the reason the
    // old comment gave was sound: the pair is bounded by configuration, not by
    // traffic, so it cannot grow a series per request the way a path or a request
    // id would. The market is bounded the same way — it is `MARKET_SYMBOLS` — so
    // the cardinality argument survives adding it.
    //
    // What did not survive it is the *meaning*: a p95 over two markets is a number
    // about neither. `buynotbuy_provider_latency_p95_ms{provider="binance"}` used
    // to be the 95th percentile of BTCUSDT and ETHUSDT together, so a p95 that
    // crossed the alert threshold could not be attributed to a series, and a
    // second market with a normal 4-second response would move the p95 of the
    // first.
    //
    // Rendered for every configured venue/market pair even before the first call,
    // so a scraper sees a zero rather than a gap. A gap and a zero look identical
    // on a graph and mean opposite things: "no traffic" and "no data".
    for (const [venue, market] of venueMarketPairs()) {
        const stats = providerTelemetry(venue, market);
        const healthState = venueHealthSummary(venue);
        const label =
            `{provider="${escapeLabel(venue)}",market="${escapeLabel(market)}"}`;

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

/**
 * The promised metrics, in the registry's own text exposition.
 *
 * The count is not written here: the catalogue in `observability/registry.ts`
 * is the promise, and a number in a comment about a closed list is one more
 * thing to forget when the list grows.
 */
function roadmapExposition(): string {
    return currentRegistry().render({ namespace: 'buynotbuy_' });
}
