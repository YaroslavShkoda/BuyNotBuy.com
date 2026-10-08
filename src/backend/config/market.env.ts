import type { MarketProviderName } from '../types/venue.js';
import { describeUnresolved, resolveInstrument } from './asset.registry.js';
import { defaultFallbackProviders, MARKET_DEFAULTS } from './market.defaults.js';
import { MarketProviderSchema } from './market.schema.js';

/**
 * The environment, read and resolved exactly once.
 *
 * Split out of the config monolith because this is the only part of it that
 * touches `process.env`: the parsers below are pure functions of their
 * arguments, and the one function that runs them is where every side effect
 * of reading a market setting lives — including the two that refuse to start
 * the process. A file that is honest about where the environment enters is
 * the file a reader checks first when a setting is not being honoured.
 */

/**
 * Returns the symbol if the registry understands it, and refuses to start if it
 * does not.
 *
 * The refusal is thrown, not returned, because the alternative is a process
 * that runs and cannot parse the market it was configured to trade. Every other
 * config failure in this file is already fatal at import time, and a symbol is
 * no different: it is the one setting a running system is least able to do
 * without.
 */
function resolvableSymbol(symbol: string): string {
    if (resolveInstrument(symbol) === null) {
        throw new Error(
            `MARKET_SYMBOL is set to ${describeUnresolved(symbol)}. ` +
                'The process will not start on a market it cannot name.',
        );
    }

    return symbol;
}

/**
 * Whether this process is allowed to serve invented prices.
 *
 * The guard on the backup list already refuses a mock there, and for the same
 * reason it has to refuse one here: `MARKET_PROVIDER=mock` is a documented
 * setting, and a mock as the primary puts 900 synthetic candles on the
 * dashboard — passing every integrity check, since they are increasing, finite
 * and internally consistent — and reports them as a live signal with
 * `X-Data-Stale: false`. Nothing on the page would look wrong.
 *
 * The escape hatch is explicit and narrow: a test double is a legitimate thing
 * to run, so the setting that allows one exists, and it is named for what it
 * does rather than inferred from the environment.
 */
function mockProviderAllowed(): boolean {
    if (process.env.MARKET_ALLOW_MOCK === '1') {
        return true;
    }

    return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

/**
 * Reads the backup list from a comma-separated setting.
 *
 * Two rules, both about not quietly doing the wrong thing:
 *
 * - A backup that names the primary is dropped rather than rejected. A
 *   deployment that sets both to the same venue has asked for no backup, and
 *   the intent is unambiguous even though the setting is not.
 * - `mock` is refused outright. A mock is a test double, and a mock that took
 *   over would put invented prices on the dashboard the moment a real venue
 *   failed — the one outcome this application exists to avoid, and the one no
 *   screenshot of the page would ever make obvious.
 */
export function parseFallbackProviders(
    raw: string,
    primary: MarketProviderName,
): MarketProviderName[] {
    const names = raw
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');

    if (names.includes('mock')) {
        throw new Error(
            'MARKET_FALLBACK_PROVIDERS cannot include "mock": a test double must never take over from a real venue',
        );
    }

    const parsed = MarketProviderSchema.array().parse(names);

    return parsed.filter((name) => name !== primary);
}

/**
 * Turns a candle interval label into milliseconds.
 *
 * Called on the same string the schema validates, and the schema rejects an
 * unparseable one a few lines later, so by the time this is wrong the process
 * is already refusing to start. `NaN` is the honest answer for a label this
 * cannot read, and it fails the `positive()` integer check rather than
 * silently becoming zero.
 */
export function intervalMs(label: string): number {
    const multipliers: Record<string, number> = {
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
        w: 604_800_000,
    };

    const unit = label.slice(-1);
    const amount = Number.parseInt(label.slice(0, -1), 10);

    return amount * (multipliers[unit] ?? Number.NaN);
}

/**
 * Every market this process observes, in the order it observes them.
 *
 * **Derived, not a field, and the primary is not asked twice.** `symbol` is the
 * market the frozen `/api/analysis` and `/api/market` routes answer for, so it
 * stays the primary and stays first. `MARKET_SYMBOLS` names the *rest*, and every
 * name in it goes through the same `resolvableSymbol` that refuses an unknown
 * ticker at boot — so adding a market cannot buy the failure mode this file
 * exists to prevent, where `symbol` was well-formed and meaningless at the same
 * time and only one of the two was being checked.
 *
 * Unset means exactly one market, which is what every deployment of this project
 * has ever run. The list is a seam, not a switch: nothing about the behaviour
 * changes until someone names a second market, and the loop that consumes it is
 * written and tested with two so that the day it is used it has been run.
 *
 * The duplicates and the primary are removed rather than refused, because a list
 * that names the same market twice is a typo with an obvious reading, and a
 * process that observes BTCUSDT twice would write its history and its signals
 * twice — silently, since both tables key on the series.
 */
function observedMarkets(primary: string): readonly string[] {
    const extra = (process.env['MARKET_SYMBOLS'] ?? '')
        .split(',')
        .map((name) => name.trim().toUpperCase())
        .filter((name) => name.length > 0);

    return [primary, ...extra.filter((name) => name !== primary)]
        .map(resolvableSymbol)
        // Every repeat is dropped, not just the ones naming the primary.
        //
        // The filter above removes the primary from the added list because a
        // primary listed twice is a mistake in the reading of the setting. It
        // does not remove a repeat **inside** the added list, and it did not for
        // as long as this function existed: the comment above promised both and
        // the code delivered one.
        //
        // The reason it matters is that this array is the loop in `server.ts`,
        // and every pass publishes signals, settles forward returns, reconciles
        // outcomes and flushes the history backlog. `MARKET_SYMBOLS=ETHUSDT,ETHUSDT`
        // therefore ran the whole cycle twice per tick — and `storeSnapshot`
        // deduplicates on the input hash, so the duplication showed up in no
        // table an operator would check.
        //
        // `Set` rather than a filter over an index counter, because "first
        // occurrence wins" is the reading a person means when they write a name
        // twice, and it is the one the loop needs: order decides which market is
        // the primary of the extra list.
        .filter((name, index, all) => all.indexOf(name) === index);
}

/**
 * What the environment says about the market, resolved once.
 *
 * `fallbackProvidersRaw` is the backup list as the deployment wrote it — or
 * the default it is riding — because choosing the default is an environment
 * question, while parsing and validating it stays with the runtime that
 * builds the failover chain.
 */
interface MarketEnv {
    primaryProvider: MarketProviderName;
    symbol: string;
    fallbackSymbol: string;
    candleInterval: string;
    symbols: readonly string[];
    fallbackProvidersRaw: string;
}

/**
 * Everything the environment says about the market, resolved once.
 *
 * Runs at configuration time and is the only place `process.env` is read for
 * market settings. The mock guard runs here rather than at the assembled
 * config, because the refusal is about the *setting*, not the shape — by the
 * time the schema would see it, `mock` is already a valid venue name.
 */
export function readMarketEnv(): MarketEnv {
    /**
     * Read through the schema rather than cast, so an unsupported venue is named in
     * the failure instead of surfacing later as a default branch that throws the
     * same message for every typo. It is also needed twice — here and again for
     * the backup list — so it is resolved once, at the boundary, where the rest of
     * the configuration is validated.
     */
    const primaryProvider = MarketProviderSchema.parse(
        process.env.MARKET_PROVIDER ?? MARKET_DEFAULTS.primaryProvider,
    );

    if (primaryProvider === 'mock' && !mockProviderAllowed()) {
        throw new Error(
            'MARKET_PROVIDER=mock is not allowed outside the test suite: a mock ' +
                'primary serves invented prices as if they were live, and reports ' +
                'them with no staleness flag. Set MARKET_ALLOW_MOCK=1 if this is ' +
                'really what you want.',
        );
    }

    /**
     * Resolved before the literal because the capability table is derived from
     * them, and a field cannot refer to a sibling declared after it. Naming them
     * here rather than repeating the environment reads keeps one definition of
     * what this deployment trades.
     */
    const symbol = resolvableSymbol(process.env.MARKET_SYMBOL ?? MARKET_DEFAULTS.symbol);
    const fallbackSymbol = resolvableSymbol(
        process.env.MARKET_FALLBACK_SYMBOL ??
            process.env.MARKET_SYMBOL ??
            MARKET_DEFAULTS.symbol,
    );

    return {
        primaryProvider,
        symbol,
        fallbackSymbol,
        candleInterval: process.env.MARKET_CANDLE_INTERVAL ?? MARKET_DEFAULTS.candleInterval,
        symbols: observedMarkets(symbol),
        fallbackProvidersRaw:
            process.env.MARKET_FALLBACK_PROVIDERS ??
            defaultFallbackProviders(primaryProvider),
    };
}
