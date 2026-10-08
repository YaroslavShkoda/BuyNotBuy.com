import { marketConfig } from '../../config/market.config.js';
import { currentRegistry } from '../../observability/registry.js';

/**
 * Latency and error-rate telemetry for outbound provider calls.
 *
 * A histogram would be the textbook answer and would also be the wrong one: it
 * needs a bucket layout chosen in advance, it is unbounded in the number of
 * label sets, and a process that makes four calls a minute does not need 10,000
 * buckets to notice that the primary started taking four seconds. What the
 * dashboard actually needs is "how slow is this venue lately", and a bounded
 * reservoir of recent samples answers exactly that.
 *
 * The reservoir is bounded and the bound is enforced by dropping the oldest
 * sample, so a long-running process holds a fixed amount of memory. That is a
 * real trade — the percentiles describe recent behaviour, not all-time
 * behaviour — and it is the right way round: an incident is what the percentiles
 * are read during, and the all-time numbers are already in the counters, which
 * do not decay.
 */
interface ProviderTelemetrySnapshot {
    provider: string;
    /** The market this series is about. Not implied by the venue. */
    market: string;
    requests: number;
    failures: number;
    rateLimits: number;
    retries: number;
    circuitOpens: number;
    lastLatencyMs: number | null;
    latencySamples: number;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
    latencyP99Ms: number | null;
    meanLatencyMs: number | null;
    /**
     * Failures over requests, in [0, 1]. Null when nothing has been sent, so
     * "no traffic" is never rendered as a perfect 0% error rate.
     */
    errorRate: number | null;
}

interface ProviderSeries {
    requests: number;
    failures: number;
    rateLimits: number;
    retries: number;
    circuitOpens: number;
    lastLatencyMs: number | null;
    latencyTotalMs: number;
    latencyCount: number;
    samples: number[];
    byStatus: Map<number, number>;
    byEndpoint: Map<string, { requests: number; failures: number }>;
}

const series = new Map<string, ProviderSeries>();

function seriesKey(provider: string, market: string): string {
    return `${provider.toLowerCase()}:${market.trim().toUpperCase()}`;
}

function emptySeries(): ProviderSeries {
    return {
        requests: 0,
        failures: 0,
        rateLimits: 0,
        retries: 0,
        circuitOpens: 0,
        lastLatencyMs: null,
        latencyTotalMs: 0,
        latencyCount: 0,
        samples: [],
        byStatus: new Map(),
        byEndpoint: new Map(),
    };
}

/**
 * The declared counters, written beside the telemetry that counts the same events.
 *
 * They live here rather than in the HTTP layer above so that one event is counted
 * in one place. Both stores count the same calls; when the counters were written by
 * the caller instead, a second call site that recorded telemetry and forgot the
 * registry would have produced a series that quietly stopped growing — and the
 * telemetry, which is not part of the exposition, would have kept looking right.
 *
 * Labels are the same venue and market the telemetry is keyed by, so the two cannot
 * disagree about which market a number belongs to.
 */
function labelsFor(provider: string, market: string): Record<string, string> {
    return { provider, market };
}

/**
 * One series per **venue and market**.
 *
 * A venue's p95 over two markets is a number about neither of them: the alert
 * threshold is a per-series judgement, and an operator reading
 * `buynotbuy_provider_latency_p95_ms{provider="binance"}` after a p95 crossed it
 * cannot tell which series caused the crossing. And the obvious response — a
 * slower second series — is the one that makes it a lie, because the p95 of the
 * mixture moves with traffic composition rather than with either feed.
 *
 * The `byEndpoint` dimension already existed and was not the problem: an endpoint
 * is a fixed property of a call, not a per-request value.
 */
function seriesFor(provider: string, market: string): ProviderSeries {
    const key = seriesKey(provider, market);

    const existing = series.get(key);

    if (existing !== undefined) {
        return existing;
    }

    const created = emptySeries();

    series.set(key, created);

    return created;
}

/**
 * Test hook: forget one venue, or all of them.
 *
 * The counters only ever go up, which is right in production and wrong between
 * tests. Without a scoped reset a suite that asserts "this venue was asked
 * once" is really asserting "somewhere in this file, some venue was asked
 * once", and it passes or fails according to test order.
 */
export function resetProviderTelemetry(provider?: string, market?: string): void {
    if (provider === undefined) {
        series.clear();

        return;
    }

    // Without a market this forgets the venue across every market it has served.
    // A bare `series.delete(provider)` would have silently done nothing at all now
    // that the keys carry a market — which is a reset that appears to work and a
    // suite that passes for the wrong reason.
    if (market !== undefined) {
        series.delete(seriesKey(provider, market));

        return;
    }

    const prefix = `${provider.toLowerCase()}:`;

    for (const key of [...series.keys()]) {
        if (key.startsWith(prefix)) {
            series.delete(key);
        }
    }
}

export function recordProviderRequest(
    provider: string,
    market: string,
    endpoint: string,
    latencyMs: number,
    httpStatus: number | null,
): void {
    const registry = currentRegistry();
    const labels = labelsFor(provider, market);

    registry.counter('provider_requests_total', 1, labels);

    if (Number.isFinite(latencyMs)) {
        // The distribution rather than a mean, because the tail is the part an
        // operator is waiting on and a mean is the part that hides it.
        registry.observe('provider_latency', latencyMs, labels);
    }

    const current = seriesFor(provider, market);

    current.requests += 1;
    current.lastLatencyMs = latencyMs;

    if (Number.isFinite(latencyMs)) {
        current.latencyTotalMs += latencyMs;
        current.latencyCount += 1;
        pushSample(current.samples, latencyMs);
    }

    if (httpStatus !== null) {
        current.byStatus.set(
            httpStatus,
            (current.byStatus.get(httpStatus) ?? 0) + 1,
        );
    }

    const endpointStats = current.byEndpoint.get(endpoint) ?? {
        requests: 0,
        failures: 0,
    };

    endpointStats.requests += 1;
    current.byEndpoint.set(endpoint, endpointStats);
}

export function recordProviderError(
    provider: string,
    market: string,
    endpoint: string,
): void {
    currentRegistry().counter('provider_errors_total', 1, labelsFor(provider, market));

    const current = seriesFor(provider, market);

    current.failures += 1;

    const endpointStats = current.byEndpoint.get(endpoint) ?? {
        requests: 0,
        failures: 0,
    };

    endpointStats.failures += 1;
    current.byEndpoint.set(endpoint, endpointStats);
}

export function recordProviderRateLimited(provider: string, market: string): void {
    currentRegistry().counter('provider_rate_limits', 1, labelsFor(provider, market));

    seriesFor(provider, market).rateLimits += 1;
}

export function recordProviderRetry(provider: string, market: string): void {
    currentRegistry().counter('provider_retries', 1, labelsFor(provider, market));

    seriesFor(provider, market).retries += 1;
}

export function recordProviderCircuitOpen(provider: string, market: string): void {
    seriesFor(provider, market).circuitOpens += 1;
}

export function providerTelemetry(
    provider: string,
    market: string,
): ProviderTelemetrySnapshot {
    const current = series.get(seriesKey(provider, market)) ?? emptySeries();

    return {
        provider,
        // Carried so a report cannot print one market's latency under another's
        // name, and so the exposition label is the market the number is about.
        market,
        requests: current.requests,
        failures: current.failures,
        rateLimits: current.rateLimits,
        retries: current.retries,
        circuitOpens: current.circuitOpens,
        lastLatencyMs: current.lastLatencyMs,
        latencySamples: current.samples.length,
        latencyP50Ms: percentile(current.samples, 50),
        latencyP95Ms: percentile(current.samples, 95),
        latencyP99Ms: percentile(current.samples, 99),
        meanLatencyMs:
            current.latencyCount === 0
                ? null
                : current.latencyTotalMs / current.latencyCount,
        errorRate:
            current.requests === 0
                ? null
                : current.failures / current.requests,
    };
}

export function providerTelemetryAll(): ProviderTelemetrySnapshot[] {
    return [...series.keys()].map((key) => {
        const separator = key.indexOf(':');

        return providerTelemetry(key.slice(0, separator), key.slice(separator + 1));
    });
}

/**
 * Drops the oldest sample rather than refusing the new one.
 *
 * A reservoir that stops accepting samples is a lie: the outage that made the
 * venue slow is exactly the traffic whose latencies matter, and a full buffer
 * would freeze the percentiles at the values from before it. Losing the tail
 * keeps the window describing the present.
 */
function pushSample(samples: number[], value: number): void {
    samples.push(value);

    const limit = marketConfig.providerLatencySampleSize;

    if (samples.length > limit) {
        samples.splice(0, samples.length - limit);
    }
}

/**
 * Nearest-rank percentile over the reservoir.
 *
 * Nearest-rank rather than interpolation because these numbers end up on an
 * alert threshold: "p95 above 2s" should mean "at least 5% of recent calls took
 * over 2s", which is the nearest-rank reading and not the interpolated one.
 * A null for an empty reservoir, so "nothing measured" is never rendered as 0.
 */
export function percentile(
    samples: readonly number[],
    rank: number,
): number | null {
    if (samples.length === 0) {
        return null;
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const position = Math.ceil((rank / 100) * sorted.length) - 1;
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, position),
    );

    return sorted[index] ?? null;
}
