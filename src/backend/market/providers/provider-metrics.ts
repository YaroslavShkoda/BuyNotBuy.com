import { marketConfig } from '../../config/market.config.js';
import { observabilityConfig } from '../../config/observability.config.js';
import type { MetricRegistry } from '../../observability/registry.js';
import { currentRegistry } from '../../observability/registry.js';
import { venuesServing } from '../market.provider.js';
import { venueHealth, venueHealthSummary } from './provider-http.js';
import { providerTelemetry, providerTelemetryAll } from './provider-telemetry.js';

/**
 * The five gauges, computed from what is already measured.
 *
 * **A gauge is pull-shaped and these five are derived.** Counters and distributions
 * are written where the event happens; a gauge is a statement about the present, and
 * the present is only knowable when somebody looks. So they are set here, from the
 * telemetry and health records, rather than accumulated at the event — and this
 * function is called immediately before the exposition is rendered, which is what
 * makes "the current value" mean the value at read time instead of the value at the
 * last event.
 *
 * It replaces a hand-written block in `api/lib/metrics.ts` that computed the same
 * five numbers and printed them under names the catalogue did not contain, with
 * kinds the catalogue argued against: a counter for something that is 1 or 0, and a
 * mean for something whose tail is the point. A closed catalogue exists so the
 * exposition can be diffed against the promise, and that diffing was impossible
 * while these names were written anywhere else.
 *
 * Set for every configured venue/market pair, not only the ones with traffic, so a
 * scraper sees a zero rather than a gap — a gap and a zero look identical on a
 * graph and mean opposite things.
 */
export function publishProviderGauges(
    registry: MetricRegistry = currentRegistry(),
): void {
    for (const [venue, market] of venueMarketPairs()) {
        const labels = { provider: venue, market };
        const stats = providerTelemetry(venue, market);
        const health = venueHealth(venue, market);
        const worst = venueHealthSummary(venue);

        // The one gauge the catalogue says cannot be a counter: it is 1 or 0, and a
        // counter of it would have to go backwards when the breaker closes.
        registry.gauge('provider_circuit_open', health.circuit === 'open' ? 1 : 0, labels);

        registry.gauge(
            'provider_error_rate',
            stats.requests === 0 ? 0 : stats.failures / stats.requests,
            labels,
        );

        registry.gauge('provider_health', health.available ? 1 : 0, labels);

        registry.gauge(
            'provider_consecutive_failures',
            // The venue's worst, not this series': a "failures since the last
            // success" that read zero because another market succeeded would be the
            // same number the old shared record produced, and it was wrong.
            worst.consecutiveFailures,
            labels,
        );
    }

    registry.gauge('metric_series_limit', metricSeriesLimit());
}

/**
 * Every configured venue/market pair, plus any pair telemetry has seen.
 *
 * A market that was called and is no longer configured still appears: hiding it
 * would be worse than showing it.
 */
function venueMarketPairs(): [string, string][] {
    const pairs = new Map<string, [string, string]>();

    // **Served pairs, not the cross product.** The first version of this function
    // multiplied venues by markets, so with `binance=BTCUSDT@1h;bitget=ETHUSDT@1h`
    // it published `provider_health{market="ETHUSDT",provider="binance"} 1` for a
    // venue that has never been asked about ETHUSDT — and read healthy, because a
    // venue nobody called is `degraded`, and degraded counts as available.
    //
    // The gap-versus-zero reasoning that motivated the cross product is right about
    // the *served* pairs and wrong here: a series for a pair that cannot exist is
    // not a gap in the data, it is a claim that the pair can serve, and an operator
    // reading it concludes binance serves ETHUSDT.
    for (const market of marketConfig.symbols) {
        for (const venue of venuesServing(market)) {
            pairs.set(`${venue}:${market}`, [venue, market]);
        }
    }

    // Plus whatever was actually called: a market that was configured and then
    // removed still appears, and hiding a call that happened would be worse than
    // showing a pair that no longer serves.
    for (const entry of providerTelemetryAll()) {
        pairs.set(`${entry.provider}:${entry.market}`, [entry.provider, entry.market]);
    }

    return [...pairs.values()];
}

/** The exposition's own series limit, read where it is defined. */
function metricSeriesLimit(): number {
    return observabilityConfig.metricLabelLimit;
}