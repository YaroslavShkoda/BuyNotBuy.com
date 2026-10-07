import type { FastifyReply, FastifyRequest } from 'fastify';
import { signalHistoryBacklog } from '../../history/signal-history.service.js';
import { indicatorVoteBacklog } from '../../indicators/performance/indicator-performance.service.js';
import { publishProviderGauges } from '../../market/providers/provider-metrics.js';
import { currentRegistry } from '../../observability/registry.js';
import { strategyDecisionBacklog } from '../../services/analysis.persistence.js';

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
    // The provider gauges, set immediately before they are read back.
    //
    // This is the pull half of the registry working as intended: a counter or a
    // distribution is written where the event happens and accumulated, while a
    // gauge is a statement about now and can only be computed by somebody looking.
    // Calling it here — rather than at some tick — is what makes `provider_health`
    // mean the state at scrape time instead of the state at the last request.
    publishProviderGauges();

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
        ['strategy_decision', strategyDecisionBacklog()],
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
            '',
            // The durable lane's queue, exposed separately from `buffered` on
            // purpose: the two numbers are two different ceilings, and reading
            // only the memory one would call a long outage survived while the
            // entries are sitting in a file.
            `# HELP buynotbuy_write_backlog_${name}_spooled Records held on disk for a retry, surviving a restart.`,
            `# TYPE buynotbuy_write_backlog_${name}_spooled gauge`,
            `buynotbuy_write_backlog_${name}_spooled ${state.spooled}`,
        );

        // **Per market as well, and the unlabelled series stays.**
        //
        // The totals above were the only family in the exposition with no market
        // to read them against, and the counts they summarise cannot even be
        // attributed: one queue serves every market, so a drop says nothing about
        // which one lost the record. That matters more than the count, because a
        // full buffer evicts the **oldest** entry — a market in a long outage can
        // take out a healthy market's records, and the hole appears in a series
        // nobody logged a failure for.
        //
        // The totals are kept rather than replaced, because they are the question
        // "is anything being lost at all", and dropping them would take a working
        // dashboard offline to fix an attribution problem.
        for (const [market, perMarket] of Object.entries(state.byMarket)) {
            lines.push(
                '',
                `# HELP buynotbuy_write_backlog_${name}_buffered Records held for a retry, by market.`,
                `# TYPE buynotbuy_write_backlog_${name}_buffered gauge`,
                `buynotbuy_write_backlog_${name}_buffered{market="${escapeLabel(market)}"} ${perMarket.buffered}`,
                '',
                `# HELP buynotbuy_write_backlog_${name}_dropped_total Records lost to a full buffer, by market.`,
                `# TYPE buynotbuy_write_backlog_${name}_dropped_total counter`,
                `buynotbuy_write_backlog_${name}_dropped_total{market="${escapeLabel(market)}"} ${perMarket.dropped}`,
                '',
                `# HELP buynotbuy_write_backlog_${name}_spooled Records held on disk for a retry, by market.`,
                `# TYPE buynotbuy_write_backlog_${name}_spooled gauge`,
                `buynotbuy_write_backlog_${name}_spooled{market="${escapeLabel(market)}"} ${perMarket.spooled}`,
            );
        }
    }

    // Provider metrics are no longer written here.
    //
    // **This block used to be ten hand-written names**, and it disagreed with the
    // closed catalogue about every one of them the catalogue mentioned: a counter
    // where the catalogue declares a gauge (`provider_circuit_open`), a mean where
    // it declares a distribution (`provider_latency`), and a different name again
    // for the rate-limit counter.
    //
    // That is the bypass the closed list exists to prevent — a name in the
    // exposition that no declaration promised, so nothing could notice it changing
    // or vanishing. The five counters and the latency distribution are now written
    // where the event happens (`providers/provider-http.ts`), and the five gauges
    // are derived at read time (`providers/provider-metrics.ts`), because a gauge is
    // a statement about the present and the present is only knowable when somebody
    // looks.

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
