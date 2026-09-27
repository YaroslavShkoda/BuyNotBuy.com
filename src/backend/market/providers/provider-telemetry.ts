import { marketConfig } from '../../config/market.config.js';

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
export interface ProviderTelemetrySnapshot {
    provider: string;
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

function seriesFor(provider: string): ProviderSeries {
    const existing = series.get(provider);

    if (existing !== undefined) {
        return existing;
    }

    const created = emptySeries();

    series.set(provider, created);

    return created;
}

export function resetProviderTelemetry(): void {
    series.clear();
}

export function recordProviderRequest(
    provider: string,
    endpoint: string,
    latencyMs: number,
    httpStatus: number | null,
): void {
    const current = seriesFor(provider);

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

export function recordProviderError(provider: string, endpoint: string): void {
    const current = seriesFor(provider);

    current.failures += 1;

    const endpointStats = current.byEndpoint.get(endpoint) ?? {
        requests: 0,
        failures: 0,
    };

    endpointStats.failures += 1;
    current.byEndpoint.set(endpoint, endpointStats);
}

export function recordProviderRateLimited(provider: string): void {
    seriesFor(provider).rateLimits += 1;
}

export function recordProviderRetry(provider: string): void {
    seriesFor(provider).retries += 1;
}

export function recordProviderCircuitOpen(provider: string): void {
    seriesFor(provider).circuitOpens += 1;
}

export function providerTelemetry(
    provider: string,
): ProviderTelemetrySnapshot {
    const current = series.get(provider) ?? emptySeries();

    return {
        provider,
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
    return [...series.keys()].map((provider) => providerTelemetry(provider));
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
