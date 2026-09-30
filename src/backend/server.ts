import { createApp } from './app.js';
import { appConfig } from './config/app.config.js';
import { historyConfig } from './config/history.config.js';
import { marketConfig } from './config/market.config.js';
import { assertSignalHistorySchemaReady } from './history/signal-history.repository.js';
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
import { analyzeMarket } from './services/analysis.service.js';
import { startPoller } from './services/poller.js';

import type { IngestionScheduler } from './history/ingestion.service.js';
import type { Poller } from './services/poller.js';
import type { Candle } from './types/market.js';

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
 * The candle window the poller settles against.
 *
 * Read before the analysis so the cached snapshot is reused rather than
 * fetched twice, and so a market outage fails the cycle before anything is
 * half-written.
 */
async function getMarketSeries(): Promise<Candle[]> {
    return (await getMarketData()).data.candles;
}

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
                    const candles = await getMarketSeries();

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
                    const measured = await reconcileSignalOutcomes({
                        key: configuredSeries(),
                        candles,
                        limit: historyConfig.maxEntries,
                    });

                    if (measured.examined > 0) {
                        app.log.info(
                            { event: 'signal_outcomes_reconciled', ...measured },
                            'signal_outcomes_reconciled',
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
