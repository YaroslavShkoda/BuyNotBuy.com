import type { FastifyInstance } from 'fastify';
import {
    flushSignalHistoryBacklog,
    signalHistoryBacklog,
} from '../history/signal-history.service.js';
import {
    flushIndicatorVoteBacklog,
    indicatorVoteBacklog,
} from '../indicators/performance/indicator-performance.service.js';
import {
    flushStrategyDecisionBacklog,
    strategyDecisionBacklog,
} from '../services/analysis.persistence.js';
import { closeDatabase } from './database.js';
import type { MarketWorkers } from './workers.js';

type Log = FastifyInstance['log'];

interface ShutdownHandlers {
    log: Log;
    workers: MarketWorkers;
    /** Closes the HTTP server; the pool is closed here, after the backlogs drain. */
    closeApp(): Promise<void>;
}

/**
 * Drains all three write backlogs and reports what could not be saved.
 *
 * Runs before the pool closes, and never throws: a failure to flush must not
 * stop the shutdown, because the next step is to close the pool and exit, and
 * arriving there with a warm backlog still loses those records. The counts go
 * to the log so a deploy that cannot save its backlog says so on the way out.
 */
async function drainWriteBacklogs(log: Log): Promise<void> {
    const history = signalHistoryBacklog();
    const votes = indicatorVoteBacklog();
    const decisions = strategyDecisionBacklog();

    log.info(
        {
            event: 'shutdown_backlog',
            historyBuffered: history.buffered,
            historySpooled: history.spooled,
            historyDropped: history.dropped,
            voteBuffered: votes.buffered,
            voteSpooled: votes.spooled,
            voteDropped: votes.dropped,
            decisionBuffered: decisions.buffered,
            decisionSpooled: decisions.spooled,
            decisionDropped: decisions.dropped,
        },
        'shutdown_backlog',
    );

    try {
        const [writtenHistory, writtenVotes, writtenDecisions] = await Promise.all([
            flushSignalHistoryBacklog(log),
            flushIndicatorVoteBacklog(log),
            flushStrategyDecisionBacklog(log),
        ]);

        if (writtenHistory > 0 || writtenVotes > 0 || writtenDecisions > 0) {
            log.info(
                {
                    event: 'shutdown_backlog_flushed',
                    historyWritten: writtenHistory,
                    votesWritten: writtenVotes,
                    decisionsWritten: writtenDecisions,
                    historyStillBuffered: signalHistoryBacklog().buffered,
                    votesStillBuffered: indicatorVoteBacklog().buffered,
                    decisionsStillBuffered: strategyDecisionBacklog().buffered,
                },
                'shutdown_backlog_flushed',
            );
        }
    } catch (error) {
        log.error(
            { event: 'shutdown_backlog_flush_failed', err: error },
            'shutdown_backlog_flush_failed',
        );
    }
}

/**
 * The shutdown sequence, registered once.
 *
 * The order is the whole content: loops stop first (a cycle in flight would
 * otherwise write against a pool that is about to close), the lease is handed
 * to a contender, the backlogs drain before the pool closes — SIGTERM is
 * exactly how every rolling deploy and every `docker stop` arrives, and the
 * memory backlogs live in this process and nowhere else, so not draining them
 * is not a delayed write but the record going away; the spooled half would
 * survive, and draining here saves it the round trip through the next boot
 * besides — then the socket closes, then the pool. A second signal is
 * ignored: re-entry would drain a second time over queues already drained.
 */
export function registerShutdownHandlers(handlers: ShutdownHandlers): void {
    const { log, workers, closeApp } = handlers;

    let isShuttingDown = false;

    const shutdown = async (): Promise<void> => {
        if (isShuttingDown) {
            return;
        }

        isShuttingDown = true;

        await workers.stop();

        await drainWriteBacklogs(log);

        try {
            await closeApp();
        } catch (error) {
            log.error(error);
            process.exit(1);
        }

        await closeDatabase();
    };

    process.on('SIGINT', () => {
        void shutdown();
    });

    process.on('SIGTERM', () => {
        void shutdown();
    });
}
