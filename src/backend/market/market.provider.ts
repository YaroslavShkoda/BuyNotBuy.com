import { marketConfig } from '../config/market.config.js';

import { BinanceProvider } from './providers/binance.provider.js';
import { BitgetProvider } from './providers/bitget.provider.js';
import { MockProvider } from './providers/mock.provider.js';
import { FailoverProvider } from './failover.provider.js';
import { isVenueAvailable } from './providers/provider-http.js';
import { describeRoute, route, serves } from './capability.js';
import { MarketDataError } from '../errors/market-data.error.js';

import type { MarketProviderName } from '../config/market.config.js';
import type { VenueCapability } from './capability.js';
import type { MarketDataProvider } from './providers/market-data.provider.js';

/**
 * Builds one venue, for one market.
 *
 * Each is given the base URL and ticker that venue was configured with. The
 * backup does not inherit the primary's address — a deployment that cannot
 * reach one venue is exactly the deployment for which the other address is the
 * value, and inheriting it would defeat the setting.
 *
 * **The market is a parameter, and it was not.** Every venue used to be built
 * with `marketConfig.symbol`, so a provider was bound to one market for its
 * whole life. That was invisible while the process only ever asked about that
 * market, and it became a lie the moment routing sent anything else: the
 * capability table can declare that a venue serves `ETHUSDT`, the route accepts
 * it, and the provider built for that route still answers with BTC candles.
 * `market.service.ts` caught the resulting symbol mismatch and refused it, which
 * is the only reason this was caught at all — the routing above it reported
 * success.
 *
 * So the symbol a venue serves is decided at the call, and the capability table
 * is finally the thing that decides it rather than a filter applied to a decision
 * already made.
 *
 * There is deliberately no helper here that answers "which market does this venue
 * serve by default". The project's own architecture guard refuses a declaration
 * shaped like that, and it is right to: a function that can be asked for the
 * default market is the seam the per-market work removed, and reintroducing it
 * under a friendlier name would put the single-market process back with the
 * guard reporting nothing. The one process-wide provider below states its markets
 * where it is built.
 */
function createVenue(
    name: MarketProviderName,
    symbol: string,
): {
    name: string;
    provider: MarketDataProvider;
} {
    switch (name) {
        case 'binance':
            return {
                name,
                provider: new BinanceProvider(symbol),
            };

        case 'bitget':
            return {
                name,
                provider: new BitgetProvider({
                    baseUrl: marketConfig.fallbackBaseUrl,
                    symbol,
                }),
            };

        case 'mock':
            return {
                name,
                provider: new MockProvider(symbol),
            };

        default:
            throw new Error(
                `Unsupported market data provider: ${name}`,
            );
    }
}

/**
 * The chain serving a routed market, keyed by market.
 *
 * Memoised because a chain carries state worth keeping: a circuit breaker that
 * resets every request cannot open, a recovery counter that starts over cannot
 * complete, and a failover chain that forgets which venue just timed out will try
 * it again first.
 *
 * Keyed by market alone, because the value *is* the market's chain — venue order
 * inside it comes from the capability table, not from the key.
 */
const routedChains = new Map<string, MarketDataProvider>();

function createMarketDataProvider(): MarketDataProvider {
    const primary = createVenue(marketConfig.provider, marketConfig.symbol);

    if (marketConfig.fallbackProviders.length === 0) {
        return primary.provider;
    }

    // **Every backup serves this market, and the chain is built from the
    // capability table like every other chain.**
    //
    // It used to ask each backup for "its own configured ticker", which is where
    // this went wrong: with `MARKET_SYMBOL=BTCUSDT`, `MARKET_FALLBACK_SYMBOL=ETHUSDT`
    // and both markets declared, the chain for BTCUSDT was
    // `[binance:BTCUSDT, bitget:ETHUSDT]` — so the moment binance opened, BTCUSDT
    // was served by a venue that answers ETHUSDT. The refusal came from
    // `market.service.ts`, which compares the symbol it was handed against the
    // request, so no wrong price was stored; the failure surfaced as a 503 about
    // ETHUSDT on a BTCUSDT request, and the operator's first guess would have been
    // the wrong venue.
    //
    // A backup that is not in this list is not usable as one, and saying so is
    // better than quietly removing it from the rotation: `MARKET_FALLBACK_PROVIDERS`
    // is a declaration of intent, and silently having one fewer backup than declared
    // is the same class of quiet as a chain that fails over to the wrong market.
    const serving = venuesServing(marketConfig.symbol);

    const backups = marketConfig.fallbackProviders
        .filter((name) => name !== marketConfig.provider && serving.includes(name))
        .map((name) => ({
            name,
            provider: createVenue(name, marketConfig.symbol).provider,
        }));

    return new FailoverProvider(primary, backups);
}

export const marketDataProvider =
    createMarketDataProvider();

/** What this deployment declares each configured venue can serve. */
export function configuredVenueCapabilities(): VenueCapability[] {
    return marketConfig.venueCapabilities.map((entry) => ({
        venue: entry.venue,
        instruments: entry.instruments,
        intervals: entry.intervals,
    }));
}

/**
 * The provider that serves a given market, refused when none can.
 *
 * PHASE 3.2. The routing used to be a `switch` on a venue name, which meant the
 * only question the system could ask was "which venue is configured" and never
 * "who serves this market". Both are asked now, in the order that keeps the
 * answer checkable: the capability table decides whether a venue can serve the
 * request at all, and only then is a provider built for it.
 *
 * A market no venue claims throws rather than falling back to the first venue.
 * The fallback would answer every request, and answering an EUR request with
 * BTC candles is the failure the whole multi-asset programme exists to
 * prevent — and it would do so silently, with a healthy-looking response.
 *
 * The configured symbol is the one market always available, so a deployment
 * that configures nothing new keeps working and keeps its existing refusal for a
 * symbol the registry cannot parse.
 */
/**
 * The venue configured to serve a market, named without building anything.
 *
 * **The venue a market is *stored under* is not the venue that answered, and the
 * difference is the whole point of this function.**
 *
 * `marketProviderFor` returns a provider, and the caller that fetches with it
 * learns which venue answered from the attributed envelope. That is right for a
 * snapshot and wrong for a storage key: under failover the answering venue
 * changes from fetch to fetch, so a series key built from it would split one
 * market's history across two series every time the primary failed over — the
 * same bars, filed twice, under a venue that did not serve them an hour earlier.
 *
 * So the *configured* venue names the series, and the answering one is recorded
 * beside it. That is the arrangement migration 18 built for `signal_snapshot`: it
 * added the venue to the snapshot's fingerprint so two venues serving identical
 * candles cannot collapse into one row, and it deliberately left the storage key
 * alone. Every table keyed on `provider, symbol, interval` — candles, signal
 * history, signal state, transitions, outcomes — takes that name from here.
 *
 * **And that sentence was wrong about one table for a round.** `signal_history`
 * defaulted the venue inside its own repository and took no name from here, so the
 * second market's history was filed under the primary's venue while its candles,
 * signal state and outcomes all named the right one. Nothing collided — `symbol` is
 * in the primary key — so no test failed and no row was lost; the tables simply
 * disagreed about one market. It resolves the venue in
 * `history/signal-history.service.ts` now, on both the write and the read, because
 * they live in different functions and each defaulted independently.

 * They agree by construction now, and that is a claim with a test behind it.
 *
 * Throws for a market no venue serves, like `marketProviderFor` does and for the
 * same reason: a caller building a key must not be handed the primary's name for
 * a market the primary does not serve, because that writes plausible rows into
 * the wrong series and every later read of them is a read of another asset.
 */
export function configuredVenueFor(instrument: string): string {
    const wanted = instrument.trim().toUpperCase();

    if (wanted === marketConfig.symbol.toUpperCase()) {
        return marketConfig.provider;
    }

    const found = route(
        { instrument: wanted, interval: marketConfig.candleInterval },
        configuredVenueCapabilities(),
        configuredMarketVenues(),
    );

    if (!found.ok) {
        throw new MarketDataError(
            describeRoute(found, { instrument: wanted, interval: marketConfig.candleInterval }),
            { code: 'MARKET_PROVIDER_ERROR', cause: { requestedSymbol: wanted, reason: found.reason } },
        );
    }

    return String(found.venue);
}

/**
 * The configured venues that declare this market, in configured preference order.
 *
 * Two callers need the same answer and must not answer it differently: the chain
 * builder, which may only fail over to a venue that serves the market, and the
 * availability probe, which decides whether a stale answer is `provider_failed`.
 * A chain filtered one way and a freshness check filtered another is how a market
 * gets a backup it cannot reach and a health verdict that says the backup exists.
 *
 * A venue with no declaration is not in the list at all. The table is the
 * deployment's own statement of what it serves, so "not declared" means "not
 * offered" rather than "assumed available".
 */
export function venuesServing(instrument: string): MarketProviderName[] {
    const request = {
        instrument: instrument.trim().toUpperCase(),
        interval: marketConfig.candleInterval,
    };

    const capabilities = configuredVenueCapabilities();

    return configuredMarketVenues().filter((name) => {
        const entry = capabilities.find((capability) => capability.venue === name);

        return entry !== undefined && serves(entry, request);
    }) as MarketProviderName[];
}

export function marketProviderFor(instrument: string): MarketDataProvider {
    const wanted = instrument.trim().toUpperCase();

    if (wanted === marketConfig.symbol.toUpperCase()) {
        return marketDataProvider;
    }

    const found = route(
        { instrument: wanted, interval: marketConfig.candleInterval },
        configuredVenueCapabilities(),
        configuredMarketVenues(),
    );

    if (!found.ok) {
        throw new MarketDataError(
            describeRoute(found, { instrument: wanted, interval: marketConfig.candleInterval }),
            { code: 'MARKET_PROVIDER_ERROR', cause: { requestedSymbol: wanted, reason: found.reason } },
        );
    }

    // **A chain per market, from the venues that declare that market.**
    //
    // This used to return the bare venue the route picked, so failover existed
    // for exactly one market: the primary, which is the only one with a
    // `FailoverProvider` around it. `MARKET_FALLBACK_PROVIDERS` — the setting
    // that exists because a primary venue is unreachable from some networks — was
    // a no-op for every market but one. A routed market whose venue was down got
    // an immediate 503 while a healthy, declared backup sat unused.
    //
    // The chain's backups are filtered by the capability table, which is the part
    // that makes it safe. `FailoverProvider` asks each venue in order and does not
    // check what that venue serves — so an unfiltered chain would fail over from
    // a dead ETHUSDT venue to one that does not trade ETHUSDT, and the only thing
    // standing between that and a table of one asset's prices filed under
    // another's name is the symbol check further downstream. A backup here is one
    // that has said it serves this market.
    //
    // Cached per market, not per venue: the cache now holds chains, and a chain
    // is a property of a market. The circuit breaker and the recovery counter
    // live inside it, so a fresh chain per request would reset both on every
    // request — a breaker that cannot stay open and a recovery that can never
    // complete.
    const cached = routedChains.get(wanted);

    if (cached !== undefined) {
        return cached;
    }

    // The routed venue leads, not the configured primary: it is the one the route
    // chose for this market. The rest are the configured venues that declare the
    // same market, in configured preference order.
    const ordered: MarketProviderName[] = [
        found.venue as MarketProviderName,
        ...venuesServing(wanted).filter((name) => name !== found.venue),
    ];

    const chain = new FailoverProvider(
        { name: ordered[0]!, provider: createVenue(ordered[0]!, wanted).provider },
        ordered.slice(1).map((name) => ({
            name,
            provider: createVenue(name, wanted).provider,
        })),
    );

    routedChains.set(wanted, chain);

    return chain;
}

/**
 * The venue currently answering, or null when there is nothing to switch.
 *
 * Null rather than a name when failover is off, so a caller cannot report a
 * "venue" that was never a choice.
 */
export function activeMarketVenue(): string | null {
    return marketDataProvider instanceof FailoverProvider
        ? marketDataProvider.activeVenue
        : marketDataProvider.name;
}

/**
 * Every venue this deployment is allowed to ask, in preference order.
 *
 * Null when failover is off is *not* returned here: a deployment with one venue
 * still has a venue, and "which ones are configured" is a different question
 * from "did a switch happen".
 */
export function configuredMarketVenues(): string[] {
    return [
        marketConfig.provider,
        ...marketConfig.fallbackProviders,
    ];
}

/**
 * Whether a venue that serves this market is currently able to answer.
 *
 * The answer the freshness model needs, and the reason it cannot be derived from
 * the snapshot cache: a cache hit means nobody asked anybody, so "the market feed
 * is dead" is invisible to a request that served a perfectly good snapshot from
 * memory. Looking it up here is what lets a cached-but-current response say
 * `provider_failed` instead of `fresh`.
 *
 * **Per market, and it takes one.** It asked "is any *configured venue* available"
 * and was called from two places that were both about one market — so with a
 * deployment where binance serves BTCUSDT and bitget serves ETHUSDT, a cache hit
 * for ETHUSDT asked about binance, was told yes, and reported `fresh` with
 * `X-Data-Stale: false` while the only venue that trades ETHUSDT was refusing.
 *
 * `provider_failed` exists for exactly that case (`market-freshness.ts:19-24`), and
 * a process-wide answer made it unreachable for every market but one.
 *
 * Both halves of "an ETHUSDT outage does not mark BTCUSDT dead" are now in place:
 * this function filters to the venues that serve the market, and `isVenueAvailable`
 * is keyed by venue **and** market, so a circuit opened by one series refuses that
 * series alone.
 */
export function anyMarketProviderAvailable(instrument: string): boolean {
    return venuesServing(instrument).some((venue) => isVenueAvailable(venue, instrument));
}

/**
 * The venue currently answering for one market, or null when there is nothing to
 * switch.
 *
 * The process-wide `activeMarketVenue` answers for the primary only, because the
 * only process-wide chain is the primary's. With a chain per market (see
 * `marketProviderFor`) each market has its own `activeVenue`, and a caller asking
 * about one market must not be handed another's answer — the entire reason this
 * module exists to report a switch loudly is that a service quietly running on the
 * backup looks like a market move.
 */
export function activeVenueForMarket(instrument: string): string | null {
    const provider = marketProviderFor(instrument);

    return provider instanceof FailoverProvider ? provider.activeVenue : provider.name;
}

export interface VenueWatcherLogger {
    warn(context: Record<string, unknown>, message: string): void;
    info?(context: Record<string, unknown>, message: string): void;
}

/**
 * Reports a venue change, once, the next time it is called.
 *
 * The switch is otherwise silent, and silent is the wrong property for it. The
 * two venues do not print the same price, so a service quietly running on the
 * backup looks like a market move in every metric and every chart. An operator
 * has to be able to tell "the price changed" from "we stopped asking".
 *
 * It is a poll rather than a callback because the provider is built at import
 * time, long before the logger exists, and the poller is deliberately ignorant
 * of which venues exist.
 */
export function createVenueWatcher(
    logger: VenueWatcherLogger,
    currentVenue: () => string | null = activeMarketVenue,
    configuredPrimary: string = marketConfig.provider,
    market?: string,
): () => void {
    let last: string | null | undefined;

    return () => {
        const venue = currentVenue();

        if (venue === last) {
            return;
        }

        const from = last;

        last = venue;

        // The first observation is the process starting, not a failover, and
        // logging it as one would cry wolf on every restart. The configured
        // primary is in the line anyway, because a service that boots while the
        // primary is already unreachable starts life on the backup and an
        // operator at 3am needs to be told which venue was skipped.
        if (from === undefined) {
            if (venue !== null) {
                logger.info?.(
                    {
                        event: 'market_venue_active',
                        venue,
                        ...(market === undefined ? {} : { market }),
                        primary: configuredPrimary,
                        onBackup: venue !== configuredPrimary,
                    },
                    'market_venue_active',
                );
            }

            return;
        }

        if (venue === null) {
            return;
        }

        logger.warn(
            {
                event: 'market_venue_switched',
                from,
                to: venue,
                // A switch without a market is unreadable the moment there is more
                // than one: two venues changing at once produce two identical
                // lines, and an operator cannot tell which series moved.
                ...(market === undefined ? {} : { market }),
            },
            'market_venue_switched',
        );
    };
}
