import { createApp } from './app.js';
import { appConfig } from './config/app.config.js';
import { historyConfig } from './config/history.config.js';
import { marketConfig } from './config/market.config.js';
import { assertSignalHistorySchemaReady } from './history/signal-history.repository.js';
import { getStrategyRuleRepository } from './strategies/candidate.repository.js';
import { createEvidenceGate } from './services/promotion-gate.js';
import { createRetentionRunner } from './services/retention.runner.js';
import { getRetentionStore } from './db/retention.store.js';
import { getSignalSnapshotRepository } from './analysis/signal-snapshot.repository.js';
import { observeNewestBar } from './observability/health.registry.js';
import { getAssetRepository } from './instruments/asset.repository.js';
import { classifyByTradingWeek } from './instruments/classify.js';
import { knownAssets, resolveInstrument } from './config/asset.registry.js';
import { reconcileSignalOutcomes } from './outcomes/reconcile.js';
import { publishSignal } from './signals/publish.js';
import { closePool } from './db/pool.js';
import {
    flushSignalHistoryBacklog,
    signalHistoryBacklog,
} from './history/signal-history.service.js';
import {
    flushIndicatorVoteBacklog,
    indicatorVoteBacklog,
    settleForwardReturns,
} from './indicators/performance/indicator-performance.service.js';
import { getMarketData } from './market/market.service.js';
import { createVenueWatcher } from './market/market.provider.js';
import {
    configuredSeries,
    startIngestionScheduler,
} from './history/ingestion.service.js';
import { analyzeMarket, storeSnapshot } from './services/analysis.service.js';
import { startPoller } from './services/poller.js';

import type { IngestionScheduler } from './history/ingestion.service.js';
import type { Poller } from './services/poller.js';

const app = createApp();

/**
 * Names the venue that answered, but only when it changes.
 *
 * Created here because this is the first point with a logger; the provider was
 * built at import time and knows nothing about one.
 */
const reportVenueChange = createVenueWatcher(app.log);

let isShuttingDown = false;

// Held outside the handler so shutdown can await whatever cycle is running
// instead of tearing the database out from under an open write.
let poller: Poller | null = null;

/**
 * The candle table's own clock, separate from the analysis poller.
 *
 * Kept apart on purpose. The analysis poller answers "what does the dashboard
 * say now" and its interval is chosen for how stale a page may be; this one
 * answers "is the history complete" and its interval is chosen so a missed
 * tick costs a delay rather than an hour. Tying the two together would make
 * every change to one silently change the guarantee of the other.
 */
let ingestion: IngestionScheduler | null = null;

/**
 * One pruner for the process, not one per cycle.
 *
 * Module-level because the clock is the state: a runner that remembered only
 * its own last run would be recreated on every tick and prune on every tick,
 * which is the opposite of what the clock is for.
 */
const retention = createRetentionRunner(getRetentionStore());

/**
 * Drains both write backlogs and reports what could not be saved.
 *
 * Runs before the pool closes, and never throws: a failure to flush must not
 * stop the shutdown, because the next step is to close the pool and exit, and
 * arriving there with a warm backlog still loses those records. The counts go
 * to the log so a deploy that cannot save its backlog says so on the way out.
 */
async function drainWriteBacklogs(): Promise<void> {
    const history = signalHistoryBacklog();
    const votes = indicatorVoteBacklog();

    app.log.info(
        {
            event: 'shutdown_backlog',
            historyBuffered: history.buffered,
            historyDropped: history.dropped,
            voteBuffered: votes.buffered,
            voteDropped: votes.dropped,
        },
        'shutdown_backlog',
    );

    try {
        const [writtenHistory, writtenVotes] = await Promise.all([
            flushSignalHistoryBacklog(app.log),
            flushIndicatorVoteBacklog(app.log),
        ]);

        if (writtenHistory > 0 || writtenVotes > 0) {
            app.log.info(
                {
                    event: 'shutdown_backlog_flushed',
                    historyWritten: writtenHistory,
                    votesWritten: writtenVotes,
                    historyStillBuffered: signalHistoryBacklog().buffered,
                    votesStillBuffered: indicatorVoteBacklog().buffered,
                },
                'shutdown_backlog_flushed',
            );
        }
    } catch (error) {
        app.log.error(
            { event: 'shutdown_backlog_flush_failed', err: error },
            'shutdown_backlog_flush_failed',
        );
    }
}

async function shutdown(): Promise<void> {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;

    if (ingestion !== null) {
        await ingestion.stop();
        ingestion = null;
    }

    if (poller !== null) {
        await poller.stop();
        poller = null;
    }

    // Before the pool closes, and before the socket closes: a write still in
    // flight is a record the history exists to keep, and SIGTERM is exactly
    // how every rolling deploy and every `docker stop` arrives. The backlogs
    // live in this process and nowhere else, so not draining them here is not
    // a delayed write — it is the record going away.
    await drainWriteBacklogs();

    try {
        await app.close();
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }

    // Release the process-wide connection pool so no write is left in flight
    // at exit. Awaited: a process that walks away mid-write loses that write,
    // and the history is exactly the record that must not have holes in it.
    await closePool();
}

process.on('SIGINT', () => {
    void shutdown();
});

process.on('SIGTERM', () => {
    void shutdown();
});

async function startServer() {
    try {
        // Before the socket opens: a database this build cannot read is a
        // deployment mistake, and finding it at boot beats finding it on the
        // first market request while the service looks healthy. Applying the
        // migrations here also creates the schema on a fresh database.
        await assertSignalHistorySchemaReady();

        // The evidence gate, attached before anything can promote a rule. Every
        // other entry point — the two research CLIs — reaches the same shared
        // repository and therefore the same gate, because the gate is attached
        // to the singleton rather than to one caller. Attaching it later, or
        // letting a later caller ask for an ungated one, would leave the ladder
        // open on every path that had not been thought about.
        getStrategyRuleRepository(createEvidenceGate());

        // The registry moves into the database, and the configuration stays on
        // top of it: the config is the declaration, this writes it down, and
        // `ON CONFLICT DO NOTHING` means a row a person suspended or a
        // classification learned from data is never quietly reset to the value
        // somebody typed. It runs before the socket opens for the same reason
        // the schema check does — a database that cannot answer "is this asset
        // tradable" should be found at boot, not on the first order.
        const seeded = await getAssetRepository().seedFromConfiguration(
            knownAssets.map((entry) => ({
                symbol: entry.symbol,
                category: entry.category,
            })),
        );

        app.log.info(
            { event: 'asset_registry_seeded', inserted: seeded.inserted },
            'asset_registry_seeded',
        );

        const address = await app.listen({
            port: appConfig.port,
            host: appConfig.host,
        });

        console.log(`Server running at ${address}`);

        if (historyConfig.pollEnabled) {
            poller = startPoller({
                intervalMs: historyConfig.pollIntervalMs,
                logger: app.log,
                run: async () => {
                    // A full analysis, not just a price read: this is what
                    // records an hourly history entry, records each
                    // indicator's own vote, and keeps the snapshot cache warm
                    // for the next page load.
                    //
                    // The whole market read, not just the bars: the snapshot
                    // this cycle stores is fingerprinted on the venue that
                    // served it, and taking the configured provider instead of
                    // the answering one would produce a different hash for the
                    // same bars — which is precisely the silent collapse of two
                    // venues into one row that migration 18 was written to stop.
                    const marketRead = await getMarketData();
                    const candles = marketRead.data.candles;
                    const marketDataProvider = marketRead.data.provider;

                    // After the read rather than before it: the venue that
                    // answered is the one worth reporting, and a switch that
                    // happened during this cycle is exactly the interesting one.
                    reportVenueChange();

                    // The other end of the chain the reconciler measures. Both
                    // run here and not on a request, for the reason the
                    // poller's own comment gives: a signal published only when
                    // somebody opens the dashboard leaves holes in the record
                    // that read as "the signal never changed".
                    const analysis = await analyzeMarket(app.log, 'poller', app.log);
                    const verdict = analysis.signal;
                    const lastBar = candles[candles.length - 1];

                    // Told to the health registry, which is the only thing in
                    // the project that reports how old the data being served
                    // is. Before this, the registry answered `ageMs: () => 0`
                    // and `stale: false` — a check that said «снимок получен
                    // напрямую» at every instant of the process's life,
                    // including every instant it served week-old candles.
                    observeNewestBar(lastBar?.timestamp ?? 0, Date.now());

                    if (lastBar === undefined) {
                        // No bar means no bar timestamp, and the lifecycle needs
                        // one to tell expiry from silence. Publishing a zero
                        // instead would age every live signal by half the
                        // universe and expire the entire history in one pass, so
                        // this cycle does nothing and says so.
                        app.log.warn(
                            { event: 'signal_publish_skipped', reason: 'no_candles' },
                            'signal_publish_skipped',
                        );
                    } else {
                        // The snapshot is stored here, on the cycle, and not only
                        // on a request — a hit rate measured today has to be
                        // re-derivable tomorrow whether or not anybody opened
                        // the dashboard in between. The analysis writes the same
                        // row fire-and-forget; `record` is idempotent on the
                        // input hash, so whichever lands second deduplicates
                        // rather than producing a second snapshot.
                        //
                        // Storing it here rather than in the request is what
                        // makes the id available at all. Every other write on
                        // the analysis path is `void` — decision log, history,
                        // votes, snapshot — so the id was being thrown away,
                        // and with it the only link from a signal to the rule
                        // that produced it. `null` here is a real answer: the
                        // signal still publishes, unattributed, and the
                        // settlement writes NULL rather than a guess.
                        const snapshotId = await storeSnapshot({
                            symbol: marketConfig.symbol,
                            price: analysis.price,
                            candles,
                            provider: marketDataProvider,
                            snapshot: analysis,
                        });

                        const publishedSignal = await publishSignal({
                            key: configuredSeries(),
                            // A panel with no opinion is `null`, not a
                            // zero-confidence candidate: silence and weak
                            // conviction are different facts, and the lifecycle
                            // treats them differently.
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
                            snapshotId: snapshotId === null ? null : String(snapshotId),
                        });

                        if (publishedSignal.written) {
                            app.log.info(
                                {
                                    event: 'signal_published',
                                    kind: publishedSignal.kind,
                                    toStatus: publishedSignal.toStatus,
                                    reason: publishedSignal.reason,
                                },
                                'signal_published',
                            );
                        }
                    }

                    await flushSignalHistoryBacklog(app.log);

                    // PHASE 14: what kind of market this is, decided by whether
                    // it trades at weekends, over at least a fortnight of bars
                    // so that one thin holiday cannot answer the question.
                    // The result is a fact about the market's structure, not a
                    // judgement about the strategy, which is why it may write
                    // to the registry at all — and it still may not overwrite a
                    // category a person typed.
                    const learned = classifyByTradingWeek(
                        candles,
                        Date.now(),
                    );

                    if (learned.verdict !== 'unknown') {
                        // The base of the pair, named for what it is. Calling it
                        // `quote` would be the second time in this file that a
                        // name said something other than the thing, and this is
                        // the value that ends up in `asset.symbol`.
                        const base = resolveInstrument(marketConfig.symbol)?.base?.symbol ?? null;

                        if (base !== null) {
                            const written = await getAssetRepository().recordLearnedCategory(
                                base,
                                learned.verdict,
                                Date.now(),
                            );

                            if (written.changed) {
                                app.log.info(
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

                    // Forward returns can only be filled in once the candle
                    // that closes each horizon exists, which is why this runs
                    // on a timer rather than at record time.
                    const settled = await settleForwardReturns(
                        marketConfig.symbol,
                        candles,
                        undefined,
                        app.log,
                    );

                    if (settled.settled > 0) {
                        app.log.info(
                            { event: 'indicator_votes_settled', ...settled },
                            'indicator_votes_settled',
                        );
                    }

                    // The same reasoning as above, applied to the outcome the
                    // system makes about its own accuracy. Indicator votes were
                    // being settled on this cycle and signal outcomes were not:
                    // `signal_outcome` had a repository and no caller, so the
                    // performance table, the calibration curve and every
                    // promotion decision were reading a table nothing wrote.
                    const measured = await reconcileSignalOutcomes(
                        {
                            key: configuredSeries(),
                            candles,
                            limit: historyConfig.maxEntries,
                        },
                        undefined,
                        undefined,
                        // The version is read from the snapshot the signal was
                        // published from, and that snapshot belongs to
                        // `analysis` — a layer `outcomes` may not import. The
                        // poller composes, so it is the right place to answer,
                        // and the engine stays ignorant of how snapshots are
                        // stored.
                        async (snapshotId) => {
                            const snapshot = await getSignalSnapshotRepository().byId(
                                Number(snapshotId),
                            );

                            return snapshot === null ? null : snapshot.strategyVersionId;
                        },
                    );

                    if (measured.examined > 0) {
                        app.log.info(
                            { event: 'signal_outcomes_reconciled', ...measured },
                            'signal_outcomes_reconciled',
                        );
                    }

                    // Retention, last on the cycle.
                    //
                    // Last because it is the only destructive thing here and it
                    // should run against a database this cycle has already
                    // written to, not against the state it found. Once a day, on
                    // its own clock, so the poller cadence does not decide how
                    // often a DELETE runs.
                    //
                    // `market_candles` and `signal_outcome` are protected
                    // policies and are refused outright — the bars every
                    // historical claim is measured against, and the only table
                    // that says which signals turned out right.
                    const pruned = await retention.maybeRun(Date.now());

                    if (!pruned.skipped && pruned.report !== null) {
                        app.log.info(
                            {
                                event: 'retention_run',
                                deleted: pruned.report.totalDeleted,
                                durationMs: pruned.report.totalDurationMs,
                                tables: pruned.report.results.length,
                                // Reported even when nothing was deleted: a prune
                                // that ran and found nothing and a prune that
                                // never ran produce identical silence.
                                refused: pruned.report.refused.map((entry) => entry.table),
                            },
                            'retention_run',
                        );
                    }
                },
            });

            // Started after the analysis poller so the first history entry is
            // written before the ingest loop begins filling the table that
            // entry will later be measured against. Either order works; this
            // one means the table is never behind the entry that claims to
            // have been derived from it.
            ingestion = startIngestionScheduler({
                key: configuredSeries(),
                intervalMs: marketConfig.candleIntervalMs,
                maxPeriodMs: marketConfig.candleIntervalMs,
                pollEnabled: historyConfig.pollEnabled,
                logger: app.log,
            });
        }
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }
}

startServer();
