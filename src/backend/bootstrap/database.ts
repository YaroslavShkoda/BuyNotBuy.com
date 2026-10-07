import type { FastifyInstance } from 'fastify';
import { closePool } from '../db/pool.js';
import { assertSignalHistorySchemaReady } from '../history/signal-history.repository.js';
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

type Log = FastifyInstance['log'];

/**
 * The database side of bringing the process up, and of letting it go.
 *
 * Split out of `server.ts` because the server was answering two questions at
 * once — what this process serves, and what has to be true before it may
 * serve it. The schema check and the spool replay are the second question:
 * neither has an HTTP answer, and both have to happen before the socket opens.
 */
export async function prepareDatabase(log: Log): Promise<void> {
    // Before the socket opens: a database this build cannot read is a
    // deployment mistake, and finding it at boot beats finding it on the
    // first market request while the service looks healthy. Schema changes
    // are applied by the separate db:migrate deployment job.
    await assertSignalHistorySchemaReady();

    // The durable overflow replayed before anything is served — the spool
    // is where the previous process parked the writes it could not make.
    await drainSpooledWritesAtBoot(log);
}

/**
 * Replays the durable overflow at boot, before the socket opens.
 *
 * The spool files hold writes a previous process could not make — usually one
 * that died inside a database outage — and the schema check just above is the
 * first moment a database is known to answer. Replaying before listen means a
 * dashboard's first read already contains what the previous process was
 * holding. Never throws: a spool that cannot be replayed now stays on disk for
 * the next boot, and a boot that failed over it would turn a survivable outage
 * into a service that does not come up at all.
 */
async function drainSpooledWritesAtBoot(log: Log): Promise<void> {
    const spooledBefore = totalSpooled();

    if (spooledBefore === 0) {
        return;
    }

    try {
        const [historyWritten, votesWritten, decisionsWritten] = await Promise.all([
            flushSignalHistoryBacklog(log),
            flushIndicatorVoteBacklog(log),
            flushStrategyDecisionBacklog(log),
        ]);

        log.info(
            {
                event: 'boot_spool_flushed',
                spooledBefore,
                historyWritten,
                votesWritten,
                decisionsWritten,
                stillSpooled: totalSpooled(),
            },
            'boot_spool_flushed',
        );
    } catch (error) {
        log.error(
            { event: 'boot_spool_flush_failed', spooledBefore, err: error },
            'boot_spool_flush_failed',
        );
    }
}

function totalSpooled(): number {
    return (
        signalHistoryBacklog().spooled +
        indicatorVoteBacklog().spooled +
        strategyDecisionBacklog().spooled
    );
}

/**
 * Release the process-wide connection pool so no write is left in flight at
 * exit. Awaited: a process that walks away mid-write loses that write, and the
 * history is exactly the record that must not have holes in it.
 */
export async function closeDatabase(): Promise<void> {
    await closePool();
}
