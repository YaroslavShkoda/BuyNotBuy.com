/**
 * PHASE 3.1 — which venue serves which market, at which interval.
 *
 * **The thing this replaces was never written down, which is why it survived so
 * long.** The routing used to be `Binance → BTC`, in the sense that a
 * `switch` on a venue name built one provider with one symbol taken from one
 * setting, and every market in the system was therefore whatever
 * `MARKET_SYMBOL` said. There was no model of what a venue could serve, because
 * there was only ever one thing to serve and no question to answer.
 *
 * **Capabilities are declared, not discovered.** Asking a venue what it lists
 * and trusting the answer would make routing depend on a network call at the
 * moment of decision, and a routing table that vanishes when the network does
 * is a routing table that has decided for you. A declaration can be wrong, and a
 * wrong one is visible in one place and costs one edit.
 *
 * **The refusal is the valuable half.** A market no venue claims cannot be
 * served, and the only useful thing to do about it is say so at startup, naming
 * the venues that were asked and what they do serve — the same discipline
 * `resolvableSymbol` follows for a symbol the registry cannot parse. A router
 * that silently fell back to "the first venue" would answer every request, and
 * serving BTC candles to someone who asked for EUR is the failure this whole
 * phase exists to prevent.
 */

/** A market asked for, as a ticker and a candle interval. */
export interface MarketRequest {
    readonly instrument: string;
    readonly interval: string;
}

/** What one venue declares it can serve. */
export interface VenueCapability {
    readonly venue: string;
    /** Tickers this venue is declared to trade. */
    readonly instruments: readonly string[];
    /** Candle intervals this venue is declared to serve. */
    readonly intervals: readonly string[];
}

type RouteRejection =
    /** No venue at all was offered, so there was nothing to choose. */
    | 'no_venues_configured'
    /** A venue was asked and none of them lists this ticker. */
    | 'instrument_not_served'
    /**
     * A venue lists the ticker but not this interval. Kept apart from the case
     * above because the fix is different: one is an unknown market, the other is
     * a known market at a resolution this venue does not publish.
     */
    | 'interval_not_served';

export type Route =
    | { readonly ok: true; readonly venue: string }
    | {
          readonly ok: false;
          readonly reason: RouteRejection;
          /** The venues that were asked, in the order they were offered. */
          readonly asked: readonly string[];
          /** The tickers they do serve, for a message a person can act on. */
          readonly served: readonly string[];
      };

/** Tickers are compared case-insensitively, because venues are not consistent. */
const normalise = (ticker: string): string => ticker.trim().toUpperCase();

/** Whether a venue declares it can serve this request. */
export function serves(capability: VenueCapability, request: MarketRequest): boolean {
    return (
        capability.instruments.some((ticker) => normalise(ticker) === normalise(request.instrument)) &&
        capability.intervals.some((step) => step.trim() === request.interval.trim())
    );
}

/**
 * Picks the first venue in `order` that serves the request.
 *
 * The order is the caller's because preference is a deployment decision — a
 * venue that has been answering reliably is a better primary than one that has
 * not, and that knowledge is not the router's to have.
 */
export function route(
    request: MarketRequest,
    capabilities: readonly VenueCapability[],
    order: readonly string[],
): Route {
    if (order.length === 0) {
        return { ok: false, reason: 'no_venues_configured', asked: [], served: [] };
    }

    const byName = new Map(capabilities.map((capability) => [capability.venue, capability]));

    for (const venue of order) {
        const capability = byName.get(venue);

        if (capability && serves(capability, request)) {
            return { ok: true, venue };
        }
    }

    const asked = order.filter((venue) => byName.has(venue));

    // Whether the ticker is served at *some* interval is a different answer
    // from whether this ticker is served at all, and conflating them produces
    // the message "unknown market 1h", which reads as a typo in the interval
    // when the real problem is a market nobody trades here.
    const servedSomewhere = asked.some((venue) =>
        (byName.get(venue)?.instruments ?? []).some(
            (ticker) => normalise(ticker) === normalise(request.instrument),
        ),
    );

    const served = [
        ...new Set(asked.flatMap((venue) => byName.get(venue)?.instruments ?? [])),
    ].sort();

    return {
        ok: false,
        reason: servedSomewhere ? 'interval_not_served' : 'instrument_not_served',
        asked,
        served,
    };
}

/**
 * The refusal as a sentence a person can act on.
 *
 * Same discipline as `describeUnresolved`: the message names what was asked, who
 * was asked, and what is on offer, because "unsupported market" alone sends the
 * reader back to the code to find out what supported means.
 */
export function describeRoute(refusal: Extract<Route, { ok: false }>, request: MarketRequest): string {
    if (refusal.reason === 'no_venues_configured') {
        return `No market venue is configured, so ${request.instrument} cannot be served.`;
    }

    const where =
        refusal.reason === 'interval_not_served'
            ? `serves ${request.instrument} but not at ${request.interval}`
            : `does not serve ${request.instrument}`;

    const offer = refusal.served.length === 0 ? '' : ` It serves: ${refusal.served.join(', ')}.`;

    return (
        `No configured venue ${where}. Asked: ${refusal.asked.join(', ')}.${offer}`
    );
}
