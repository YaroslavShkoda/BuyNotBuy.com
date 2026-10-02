import { marketConfig } from '../config/market.config.js';
import { historyConfig } from '../config/history.config.js';
import { resolveInstrument } from '../config/asset.registry.js';
import { getAssetRepository } from '../instruments/asset.repository.js';
import { classifyByTradingWeek } from '../instruments/classify.js';
import { getMarketData, resolveRequest } from '../market/market.service.js';
import { observeNewestBar } from '../observability/health.registry.js';
import { getSignalSnapshotRepository } from '../analysis/signal-snapshot.repository.js';
import { publishSignal } from '../signals/publish.js';
import { reconcileSignalOutcomes } from '../outcomes/reconcile.js';
import { configuredSeries } from '../history/ingestion.service.js';
import { flushSignalHistoryBacklog } from '../history/signal-history.service.js';
import { settleForwardReturns } from '../indicators/performance/indicator-performance.service.js';
import { analyzeMarket, storeSnapshot } from './analysis.service.js';

import type { AnalysisTelemetryLogger } from './analysis.telemetry.js';
import type { SignalHistoryLogger } from '../history/signal-history.types.js';
import type { IndicatorLogger } from '../indicators/performance/indicator-performance.types.js';

/**
 * One market's observation cycle, which is what the process does per market.
 *
 * **This used to be a closure inside `server.ts`, and that was the whole of
 * why the process observed one market.** The body read `marketConfig.symbol`
 * eleven times and took no market as an argument, so the only way to observe a
 * second one was to edit this file — and the only way to *test* the cycle at all
 * was to start the process, which no test does and which a test cannot undo.
 *
 * So the cycle moved out and took a market. Two consequences, and the second is
 * the reason it was worth doing:
 *
 * - `server.ts` now loops over `marketConfig.symbols` and the loop is the
 *   thing under test rather than a promise in a document.
 * - the cycle is callable, so "the two markets do not bleed into each other"
 *   becomes an assertion instead of an intention. Before this, the guarantee that
 *   BTCUSDT's bars were never filed under ETHUSDT was true by having only one
 *   market, which is not a guarantee.
 *
 * **Per-process work is deliberately not here.** Retention and the ingest
 * scheduler ran inside the old closure, and putting them in this loop would run
 * a prune once per market — the same destructive pass N times a day, silently.
 * They stay in `server.ts`, once, and the division is the reason this function
 * takes a market rather than being told what to iterate.
 *
 * Every table it writes is already keyed on `provider, symbol, interval`, so
 * nothing here needed a schema change to become correct for a second market.
 * The one place that was not keyed by market was `configuredSeries()`, which is
 * why it now takes one.
 */

export interface MarketCycleLogger {
    warn(context: Record<string, unknown>, message: string): void;
    info(context: Record<string, unknown>, message: string): void;
}

export interface MarketCycleDeps {
    /** Telemetry, history and votes all took `app.log` in the old closure. */
    readonly logger: AnalysisTelemetryLogger &
        SignalHistoryLogger &
        IndicatorLogger &
        MarketCycleLogger;
    /**
     * Names the venue that answered, but only when it changes.
     *
     * A callback rather than the watcher, because the watcher is built in
     * `server.ts` at the point where the first logger exists and this function
     * is called many times afterwards.
     */
    readonly reportVenueChange: () => void;
}

/**
 * What one cycle did, so a caller can assert on it.
 *
 * A summary rather than nothing, because "two markets, no bleed" is only a test
 * if the cycle says which rows it wrote.
 */
export interface MarketObservation {
    readonly market: string;
    readonly candles: number;
    readonly provider: string;
    readonly lastBarAt: number | null;
    readonly snapshotId: string | null;
    readonly published: boolean;
    readonly settledVotes: number;
    readonly reconciled: number;
    readonly learnedCategory: string | null;
}

export async function observeMarket(
    market: string,
    deps: MarketCycleDeps,
    now: () => number = Date.now,
): Promise<MarketObservation> {
    const { logger, reportVenueChange } = deps;

    // A full analysis, not just a price read: this is what records an hourly
    // history entry, records each indicator's own vote, and keeps the snapshot
    // cache warm for the next page load.
    //
    // The whole market read, not just the bars: the snapshot this cycle stores
    // is fingerprinted on the venue that served it, and taking the configured
    // provider instead of the answering one would produce a different hash for
    // the same bars — which is precisely the silent collapse of two venues into
    // one row that migration 18 was written to stop.
    // Through `resolveRequest` rather than by hand, so the interval is the one the
    // process is configured with instead of a second copy of that default.
    const marketRead = await getMarketData(resolveRequest({ instrument: market }));
    const candles = marketRead.data.candles;
    const marketDataProvider = marketRead.data.provider;

    // After the read rather than before it: the venue that answered is the one
    // worth reporting, and a switch that happened during this cycle is exactly
    // the interesting one.
    reportVenueChange();

    // The other end of the chain the reconciler measures. Both run here and not
    // on a request, for the reason the poller's own comment gives: a signal
    // published only when somebody opens the dashboard leaves holes in the
    // record that read as "the signal never changed".
    const analysis = await analyzeMarket(logger, 'poller', logger, market);
    const verdict = analysis.signal;
    const lastBar = candles[candles.length - 1];

    // Told to the health registry, which is the only thing in the project that
    // reports how old the data being served is. Before this, the registry
    // answered `ageMs: () => 0` and `stale: false` — a check that said «снимок
    // получен напрямую» at every instant of the process's life, including every
    // instant it served week-old candles.
    observeNewestBar(lastBar?.timestamp ?? 0, now());

    let snapshotId: string | null = null;
    let published = false;

    if (lastBar === undefined) {
        // No bar means no bar timestamp, and the lifecycle needs one to tell
        // expiry from silence. Publishing a zero instead would age every live
        // signal by half the universe and expire the entire history in one pass,
        // so this cycle does nothing and says so.
        logger.warn(
            { event: 'signal_publish_skipped', reason: 'no_candles', market },
            'signal_publish_skipped',
        );
    } else {
        // The snapshot is stored here, on the cycle, and not only on a request —
        // a hit rate measured today has to be re-derivable tomorrow whether or
        // not anybody opened the dashboard in between. The analysis writes the
        // same row fire-and-forget; `record` is idempotent on the input hash, so
        // whichever lands second deduplicates rather than producing a second
        // snapshot.
        //
        // Storing it here rather than in the request is what makes the id
        // available at all. Every other write on the analysis path is `void` —
        // decision log, history, votes, snapshot — so the id was being thrown
        // away, and with it the only link from a signal to the rule that produced
        // it. `null` here is a real answer: the signal still publishes,
        // unattributed, and the settlement writes NULL rather than a guess.
        const stored = await storeSnapshot(
            {
                symbol: market,
                price: analysis.price,
                candles,
                provider: marketDataProvider,
                snapshot: analysis,
            },
            logger,
        );

        snapshotId = stored === null ? null : String(stored);

        const publishedSignal = await publishSignal({
            key: configuredSeries(market),
            // A panel with no opinion is `null`, not a zero-confidence
            // candidate: silence and weak conviction are different facts, and
            // the lifecycle treats them differently.
            candidate:
                verdict.signal === 'NEUTRAL'
                    ? null
                    : {
                          direction: verdict.signal,
                          confidence: verdict.confidence,
                          price: analysis.price,
                          candleTimestamp: lastBar.timestamp,
                      },
            intervalMs: marketConfig.candleIntervalMs,
            candleTimestamp: lastBar.timestamp,
            snapshotId,
        });

        published = publishedSignal.written;

        if (publishedSignal.written) {
            logger.info(
                {
                    event: 'signal_published',
                    market,
                    kind: publishedSignal.kind,
                    toStatus: publishedSignal.toStatus,
                    reason: publishedSignal.reason,
                },
                'signal_published',
            );
        }
    }

    await flushSignalHistoryBacklog(logger);

    // PHASE 14: what kind of market this is, decided by whether it trades at
    // weekends, over at least a fortnight of bars so that one thin holiday cannot
    // answer the question. The result is a fact about the market's structure,
    // not a judgement about the strategy, which is why it may write to the
    // registry at all — and it still may not overwrite a category a person
    // typed.
    const learned = classifyByTradingWeek(candles, now());
    let learnedCategory: string | null = null;

    if (learned.verdict !== 'unknown') {
        // The base of the pair, named for what it is. Calling it `quote` would
        // be a second time in this file that a name said something other than
        // the thing, and this is the value that ends up in `asset.symbol`.
        const base = resolveInstrument(market)?.base?.symbol ?? null;

        if (base !== null) {
            const written = await getAssetRepository().recordLearnedCategory(
                base,
                learned.verdict,
                now(),
            );

            if (written.changed) {
                learnedCategory = base;

                logger.info(
                    {
                        event: 'asset_category_learned',
                        symbol: base,
                        category: learned.verdict,
                        evidence: learned.evidence,
                    },
                    'asset_category_learned',
                );
            }
        }
    }

    // Forward returns can only be filled in once the candle that closes each
    // horizon exists, which is why this runs on a timer rather than at record
    // time.
    const settled = await settleForwardReturns(market, candles, undefined, logger);

    if (settled.settled > 0) {
        logger.info(
            { event: 'indicator_votes_settled', market, ...settled },
            'indicator_votes_settled',
        );
    }

    // The same reasoning as above, applied to the outcome the system makes about
    // its own accuracy. Indicator votes were being settled on this cycle and
    // signal outcomes were not: `signal_outcome` had a repository and no caller,
    // so the performance table, the calibration curve and every promotion
    // decision were reading a table nothing wrote.
    const measured = await reconcileSignalOutcomes(
        {
            key: configuredSeries(market),
            candles,
            limit: historyConfig.maxEntries,
        },
        undefined,
        undefined,
        // The version is read from the snapshot the signal was published from,
        // and that snapshot belongs to `analysis` — a layer `outcomes` may not
        // import. The poller composes, so it is the right place to answer, and
        // the engine stays ignorant of how snapshots are stored.
        async (snapshotId) => {
            const snapshot = await getSignalSnapshotRepository().byId(
                Number(snapshotId),
            );

            return snapshot === null ? null : snapshot.strategyVersionId;
        },
    );

    if (measured.examined > 0) {
        logger.info(
            { event: 'signal_outcomes_reconciled', market, ...measured },
            'signal_outcomes_reconciled',
        );
    }

    return {
        market,
        candles: candles.length,
        provider: marketDataProvider,
        lastBarAt: lastBar?.timestamp ?? null,
        snapshotId,
        published,
        settledVotes: settled.settled,
        reconciled: measured.examined,
        learnedCategory,
    };
}
