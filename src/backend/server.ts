import { createApp } from './app.js';
import { appConfig } from './config/app.config.js';
import { historyConfig } from './config/history.config.js';
import { marketConfig } from './config/market.config.js';
import { assertSignalHistorySchemaReady } from './history/signal-history.repository.js';
import { closePool } from './db/pool.js';
import { flushSignalHistoryBacklog } from './history/signal-history.service.js';
import { settleForwardReturns } from './indicators/performance/indicator-performance.service.js';
import { getMarketData } from './market/market.service.js';
import { analyzeMarket } from './services/analysis.service.js';
import { startPoller } from './services/poller.js';

import type { Poller } from './services/poller.js';
import type { Candle } from './types/market.js';

const app = createApp();

let isShuttingDown = false;

// Held outside the handler so shutdown can await whatever cycle is running
// instead of tearing the database out from under an open write.
let poller: Poller | null = null;

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

async function shutdown(): Promise<void> {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;

    if (poller !== null) {
        await poller.stop();
        poller = null;
    }

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

                    await analyzeMarket(app.log, 'poller', app.log);

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
                },
            });
        }
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }
}

startServer();
