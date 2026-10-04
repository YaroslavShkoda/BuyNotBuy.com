import { flushSignalHistoryBacklog } from '../history/signal-history.service.js';
import type { SignalHistoryLogger } from '../history/signal-history.types.js';
import { flushIndicatorVoteBacklog } from '../indicators/performance/indicator-performance.service.js';
import type { IndicatorLogger } from '../indicators/performance/indicator-performance.types.js';

/**
 * Both write buffers, drained, on every tick.
 *
 * **They were not symmetric, and that was the defect.** The history buffer was
 * flushed from inside the per-market observation cycle, once per market; the vote
 * buffer had no periodic flush at all — only on shutdown, and when the buffer
 * happened to fill. So a database blip parked history entries in a buffer that got
 * retried within the same tick, and vote entries in one that waited for the process
 * to stop. Two subsystems, same failure, opposite handling, and nobody could see it
 * because each looked reasonable on its own.
 *
 * Two call sites cannot be kept symmetric by intention, and these are the same
 * question asked twice: *is there a buffered write that has not happened yet?* So it
 * is asked once, here, and the tick calls it once.
 *
 * The history flush used to be per-market and that was also wrong in a quieter way:
 * a market that failed early never reached its own flush, so its entries waited for
 * a cycle that happened to be healthy.
 *
 * Not called on the shutdown path — `drainWriteBacklogs` there awaits both with
 * `Promise.allSettled` and logs a failure, which is a different requirement: the
 * last attempt should be as loud as the others.
 */
export async function drainPeriodicBacklogs(
    logger?: SignalHistoryLogger & IndicatorLogger,
): Promise<{ history: number; votes: number }> {
    // **Both attempted, whichever fails.** Sequential awaits would let a failing
    // history drain skip the vote drain — and the buffer that failed is precisely
    // the one that most needs the next attempt, while the other one waits for a
    // tick that a single bad statement can postpone indefinitely. The first
    // version of this function did exactly that, and the test for it is why.
    const [history, votes] = await Promise.allSettled([
        flushSignalHistoryBacklog(logger),
        flushIndicatorVoteBacklog(logger),
    ]);

    for (const [name, result] of [
        ['history', history],
        ['votes', votes],
    ] as const) {
        if (result.status === 'rejected') {
            logger?.warn(
                { event: 'write_backlog_flush_failed', buffer: name, err: result.reason },
                'write_backlog_flush_failed',
            );
        }
    }

    return {
        history: history.status === 'fulfilled' ? history.value : 0,
        votes: votes.status === 'fulfilled' ? votes.value : 0,
    };
}