import { createApp } from './app.js';
import { appConfig } from './config/app.config.js';
import { historyConfig } from './config/history.config.js';
import { marketConfig } from './config/market.config.js';
import { knownAssets } from './config/asset.registry.js';
import { assertSignalHistorySchemaReady } from './history/signal-history.repository.js';
import { getStrategyRuleRepository } from './strategies/candidate.repository.js';
import { createEvidenceGate } from './services/promotion-gate.js';
import { createRetentionRunner } from './services/retention.runner.js';
import { getRetentionStore } from './db/retention.store.js';
import { getAssetRepository } from './instruments/asset.repository.js';
import { seedConfiguredRegistry } from './instruments/seed-registry.js';
import { closePool } from './db/pool.js';
import {
    flushSignalHistoryBacklog,
    signalHistoryBacklog,
} from './history/signal-history.service.js';
import {
    flushIndicatorVoteBacklog,
    indicatorVoteBacklog,
} from './indicators/performance/indicator-performance.service.js';
import { activeVenueForMarket, createVenueWatcher } from './market/market.provider.js';
import { configuredSeries } from './history/ingestion.service.js';
import { startIngestionScheduler } from './services/ingestion.scheduler.js';
import { startPoller } from './services/poller.js';
import { observeMarket, runPerMarket } from './services/market-cycle.js';
import { drainPeriodicBacklogs } from './services/write-backlog-drain.js';
import { currentRegistry } from './observability/registry.js';

import type { IngestionScheduler } from './services/ingestion.scheduler.js';
import type { Poller } from './services/poller.js';

const app = createApp();

/**
 * One venue watcher per market, not one for the process.
 *
 * It used to be a single watcher reading the process-wide chain, which is the
 * primary market's — so a switch on any other market was invisible, and a switch
 * on the primary produced a line naming no market. Per market means the watcher's
 * `last` state is per market too, which is what makes "changed" mean anything:
 * two markets that happen to sit on the same venue are not a change for either.
 */
const noop = (): void => undefined;

/**
 * One venue watcher per market, not one for the process.
 *
 * It used to be a single watcher reading the process-wide chain, which is the
 * primary market's — so a switch on any other market was invisible, and a switch
 * on the primary produced a line naming no market. Per market means the watcher's
 * `last` state is per market too, which is what makes "changed" mean anything:
 * two markets that happen to sit on the same venue are not a change for either.
 */
const venueWatchers = new Map<string, () => void>(
    marketConfig.symbols.map((market) => [
        market,
        createVenueWatcher(
            app.log,
            () => activeVenueForMarket(market),
            marketConfig.provider,
            market,
        ),
    ]),
);

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
let ingestion: IngestionScheduler[] = [];

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

    // Every scheduler, and not only the first: `stop()` awaits the cycle that is
    // in flight, so a market being written at the moment of shutdown would keep
    // its provider fetch running against a pool this function is about to close.
    // A list stopped one at a time is also the only order that lets each await
    // finish before the next begins.
    for (const scheduler of ingestion) {
        await scheduler.stop();
    }

    ingestion = [];

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
        // The registry the configuration declares, assets and instrument
        // together, before the socket opens for the same reason the schema check
        // is there: a database that cannot answer "is this asset tradable" should
        // be found at boot, not on the first order.
        //
        // The instrument is written by the same call as the assets on purpose.
        // Seeding only the assets was the live bug: nothing else in the running
        // service wrote `instrument`, so the registry route answered empty beside
        // a correct asset list, and the correctness of that list is what made the
        // emptiness look like an answer.
        const seeded = await seedConfiguredRegistry(
            getAssetRepository(),
            knownAssets,
            marketConfig.symbol,
            marketConfig.symbols,
        );

        app.log.info(
            {
                event: 'registry_seeded',
                assetsInserted: seeded.assetsInserted,
                instrument: seeded.instrument,
                instrumentInserted: seeded.instrumentInserted,
                // Every market written, so the line says what the process is
                // actually about rather than only what it was configured around.
                instruments: seeded.instruments,
            },
            'registry_seeded',
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
                    // The loop, which is the point: one observation cycle per
                    // configured market.
                    //
                    // `marketConfig.symbols` is `[symbol]` unless
                    // MARKET_SYMBOLS names another, so a deployment that sets
                    // nothing runs exactly what it ran before this existed.
                    //
                    // The per-market body moved to `services/market-cycle.ts`.
                    // It used to be this closure, and being a closure is why the
                    // process observed one market: it read
                    // `marketConfig.symbol` eleven times and took no market as an
                    // argument, so a second market meant editing this file, and
                    // testing the cycle at all meant starting the process, which
                    // no test does and which a test cannot undo.
                    //
                    // **Retention stays outside the loop, deliberately.** It is
                    // the only destructive thing on the cycle and it runs on its
                    // own clock, once a day. Inside the loop it would prune once
                    // per market, and a second prune of the same rows looks in a
                    // log like nothing at all.
                    //
                    // `runPerMarket` rather than a bare loop: a venue answering
                    // 500 must cost that market its cycle and nothing else. In
                    // the bare loop it also cost every market after it, and the
                    // retention call below — which does not come back once it is
                    // skipped, because nothing reschedules it.
                    const markets = await runPerMarket(
                        marketConfig.symbols,
                        async (market) => {
                            await observeMarket(market, {
                                logger: app.log,
                                // The watcher for *this* market. A process-wide
                                // one would report the primary's chain after every
                                // market's read, so the line would name a venue
                                // that had just served a different series.
                                reportVenueChange: venueWatchers.get(market) ?? noop,
                            });
                        },
                    );

                    // Recorded twice on purpose: once where an operator reads it,
                    // once where a dashboard can prove it stopped. The counter is
                    // labelled by market, so a permanently dead market is a
                    // growing series rather than a number mixed into all of them.
                    for (const failure of markets.failures) {
                        app.log.error(
                            {
                                event: 'market_cycle_failed',
                                market: failure.market,
                                observed: markets.observed.length,
                                err: failure.error,
                            },
                            'market_cycle_failed',
                        );

                        currentRegistry().counter('market_cycle_failures', 1, {
                            market: failure.market,
                        });
                    }

                    // Both write buffers, once per tick, after every market.
                    //
                    // The history one used to be flushed inside the per-market
                    // cycle, so a market that failed early never reached its own
                    // flush. The vote one had **no periodic flush at all** — only
                    // on shutdown and when the buffer filled — so a database blip
                    // parked history entries in a buffer that got retried and vote
                    // entries in one that did not.
                    await drainPeriodicBacklogs(app.log);

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
            //
            // **One scheduler per market, and the table was the reason.**
            // It used to be one scheduler with `configuredSeries()` — no market,
            // so the primary — and the ingest loop is the *only* writer of
            // `market_candles`. The observation loop wrote signals, snapshots and
            // settled returns for every configured market every minute, against
            // a table that had one market's bars in it. Nothing complained: the
            // table was full, the upserts succeeded, and a strategy was being
            // measured on an input that was not there.
            //
            // Separate schedulers rather than one iterating a list, because the
            // per-market isolation then comes from the poller each one already
            // has. A single loop would need the same `try/catch` per market that
            // round 86 had to add to the observation loop, and would be able to
            // forget it in exactly the same way.
            ingestion = marketConfig.symbols
                .map((market) =>
                    startIngestionScheduler({
                        key: configuredSeries(market),
                        intervalMs: marketConfig.candleIntervalMs,
                        maxPeriodMs: marketConfig.candleIntervalMs,
                        pollEnabled: historyConfig.pollEnabled,
                        logger: app.log,
                    }),
                )
                .filter((scheduler) => scheduler !== null);
        }
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }
}

startServer();
