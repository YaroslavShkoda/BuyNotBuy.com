/**
 * The background loop that fills the candle table.
 *
 * **This used to live in `history/ingestion.service.ts`, and that was backwards.**
 * The scheduler is a composition: it wires a timer to a function that happens
 * to fetch and store bars. `history/` is a domain layer, and a domain layer
 * reaching up into `services/poller.ts` for a timer inverts the direction every
 * other edge in the tree follows. The measurement in
 * `docs/roadmap-v2-status.md` lists it as M2's first remaining violation, and it
 * was accurate.
 *
 * The split is along the seam that was already there. `ingestOnce` is one
 * fetch, one classification, one write, and needs nothing from `services/`. The
 * scheduler needs the poller, the ingestion clock, and `ingestOnce` — which is
 * three reasons it belongs at the level where composition happens, next to
 * `server.ts` that starts it.
 *
 * Nothing about the loop's behaviour changed, including the part that matters
 * most: the period is still a fraction of the interval, and the reason is
 * unchanged.
 */

import { startPoller } from './poller.js';
import { ingestionPeriodMs } from '../history/candle-clock.js';
import { ingestOnce } from '../history/ingestion.service.js';

import type { IngestionOptions, IngestionResult } from '../history/ingestion.service.js';
import type { Poller, PollerLogger } from './poller.js';

export interface IngestionSchedulerOptions extends IngestionOptions {
    readonly logger: PollerLogger;
    /** Upper bound on the poll period. */
    readonly maxPeriodMs?: number;
    readonly pollEnabled?: boolean;
    readonly setTimer?: (handler: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
}

export interface IngestionScheduler extends Poller {
    /** Runs one cycle by hand, for a test or a one-shot script. */
    ingest(): Promise<IngestionResult>;
}

/**
 * Starts the background ingest loop.
 *
 * The period is a fraction of the interval rather than the interval itself, and
 * the reason is about the failure mode rather than the load. A bar closes once
 * an hour; polling once an hour means the tick that misses it — because the
 * provider was slow, because the process was busy, because the machine was
 * restarting — loses that bar for good, and a hole in the history is
 * indistinguishable from a quiet hour for ever after. Polling several times
 * per interval makes a missed tick cost a minute of delay instead of an hour
 * of data.
 */
export function startIngestionScheduler(
    options: IngestionSchedulerOptions,
): IngestionScheduler | null {
    if (options.pollEnabled === false) {
        return null;
    }

    const ingest = (): Promise<IngestionResult> => ingestOnce(options);

    const poller = startPoller({
        intervalMs: ingestionPeriodMs(
            options.intervalMs,
            options.maxPeriodMs ?? Number.POSITIVE_INFINITY,
        ),
        run: ingest,
        logger: options.logger,
        ...(options.setTimer === undefined
            ? {}
            : { setTimer: options.setTimer }),
        ...(options.clearTimer === undefined
            ? {}
            : { clearTimer: options.clearTimer }),
    });

    return Object.assign(poller, { ingest });
}
