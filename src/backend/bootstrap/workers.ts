import type { FastifyInstance } from 'fastify';
import { historyConfig } from '../config/history.config.js';
import { marketConfig } from '../config/market.config.js';
import { createLease } from '../db/lease.js';
import { getRetentionStore } from '../db/retention.store.js';
import { configuredSeries } from '../history/ingestion.service.js';
import { activeVenueForMarket, createVenueWatcher } from '../market/market.provider.js';
import { currentRegistry } from '../observability/registry.js';
import type { IngestionScheduler } from '../services/ingestion.scheduler.js';
import { startIngestionScheduler } from '../services/ingestion.scheduler.js';
import { observeMarket, runPerMarket } from '../services/market-cycle.js';
import type { Poller } from '../services/poller.js';
import { startPoller } from '../services/poller.js';
import { createRetentionRunner } from '../services/retention.runner.js';
import { drainPeriodicBacklogs } from '../services/write-backlog-drain.js';

type Log = FastifyInstance['log'];

/**
 * The loops that move market data, and nothing else.
 *
 * Split out of `server.ts` because the loops were the reason the file had
 * become a runtime orchestrator: the analysis poller, the per-market
 * ingestion schedulers, the lease that keeps one writer, and the retention
 * clock — each with its own state, none of them HTTP. Owning that state here
 * means the server composes a runtime instead of being one, and start/stop
 * is a pair of methods instead of a shutdown handler reaching into module
 * variables.
 */
export interface MarketWorkers {
    /**
     * Starts the analysis poller and the per-market ingestion schedulers.
     *
     * With the poller off, starts nothing: the process still serves reads,
     * which is what tests and one-off scripts want from it.
     */
    start(): Promise<void>;

    /**
     * Stops the loops in dependency order, then hands leadership away.
     *
     * Every scheduler, and not only the first: `stop()` awaits the cycle
     * that is in flight, so a market being written at the moment of shutdown
     * would keep its provider fetch running against a pool the caller is
     * about to close. A list stopped one at a time is also the only order
     * that lets each await finish before the next begins.
     */
    stop(): Promise<void>;
}

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

export function createMarketWorkers(log: Log): MarketWorkers {
    const venueWatchers = new Map<string, () => void>(
        marketConfig.symbols.map((market) => [
            market,
            createVenueWatcher(log, () => activeVenueForMarket(market), marketConfig.provider, market),
        ]),
    );

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

    // Held outside the handler so shutdown can await whatever cycle is running
    // instead of tearing the database out from under an open write.
    let poller: Poller | null = null;

    /**
     * One pruner for the process, not one per cycle.
     *
     * Created once per workers instance rather than per tick, because the
     * clock is the state: a runner that remembered only its own last run
     * would be recreated on every tick and prune on every tick, which is the
     * opposite of what the clock is for.
     */
    const retention = createRetentionRunner(getRetentionStore());

    /**
     * The one market writer, chosen among the processes.
     *
     * Every loop below that writes market data — the analysis poller and each
     * per-market ingestion scheduler — gates every cycle on this lease. Without
     * it, a second instance meant a second writer: duplicated observations, and a
     * `strategy_decision_log` whose only key was a surrogate `id` — until the
     * natural key landed, the duplicates could not even be told apart from the one
     * real cycle.
     *
     * The gate is consulted per cycle rather than won once at boot, and that is
     * what makes failover boring: the holder verifies its session lock each tick,
     * every contender asks for it each tick, and when the holder's connection
     * dies the database releases the lock for it — the first contender to ask
     * next becomes the leader, with no restart and no operator. A process whose
     * gate answers false simply idles: it keeps serving reads, and its skipped
     * cycles are visible in the log as `poller_cycle_skipped_by_gate`.
     */
    const marketLease = createLease({ key: 'market-pipeline', logger: log });

    return {
        async start(): Promise<void> {
            if (!historyConfig.pollEnabled) {
                return;
            }

            poller = startPoller({
                intervalMs: historyConfig.pollIntervalMs,
                logger: log,

                // The lease gate. The market cycle is the one writer the
                // system is designed around; see `marketLease` above.
                shouldRun: () => marketLease.ensureHeld(),

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
                                logger: log,
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
                        log.error(
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
                    await drainPeriodicBacklogs(log);

                    const pruned = await retention.maybeRun(Date.now());

                    if (!pruned.skipped && pruned.report !== null) {
                        log.info(
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
                        logger: log,

                        // The same lease as the analysis poller: one process
                        // owns the whole market pipeline, not one process per
                        // loop. A contender would otherwise ingest candles in
                        // parallel with the leader, which is the duplicate
                        // writer the lease exists to prevent.
                        shouldRun: () => marketLease.ensureHeld(),
                    }),
                )
                .filter((scheduler) => scheduler !== null);
        },

        async stop(): Promise<void> {
            for (const scheduler of ingestion) {
                await scheduler.stop();
            }

            ingestion = [];

            if (poller !== null) {
                await poller.stop();
                poller = null;
            }

            // After the loops have stopped, before the backlogs drain: the lease is
            // held on a session of this pool, and letting go of it explicitly hands
            // leadership to a contender now instead of when the pool closes.
            await marketLease.release();
        },
    };
}
