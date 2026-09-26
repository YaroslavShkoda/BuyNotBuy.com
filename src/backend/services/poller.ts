export interface PollerLogger {
    info(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
    warn?(context: Record<string, unknown>, message: string): void;
}

export interface PollerOptions {
    intervalMs: number;
    /** One cycle. Rejections are the poller's own problem, never the caller's. */
    run: () => Promise<unknown>;
    logger: PollerLogger;
    setTimer?: (handler: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export interface Poller {
    /** Resolves once any in-flight cycle has finished. */
    stop(): Promise<void>;
    readonly isRunning: boolean;
    /** Cycles completed since start; failures included. */
    readonly completedRuns: number;
}

/**
 * Runs one job on an interval, forever, without ever overlapping itself.
 *
 * Two things this buys that a per-request fetch does not:
 *
 *   - History records arrive even when nobody has the dashboard open. The
 *     whole stability metric is measured in hours, so a service that only
 *     writes on page load produces a history full of holes that read as
 *     "the signal never changed".
 *   - The snapshot cache stays warm, so a page load is answered from memory
 *     instead of waiting on a provider round trip.
 *
 * Overlap is prevented by tracking the in-flight cycle rather than by trusting
 * the interval to be longer than the work: a slow provider must never stack up
 * a queue of duplicate analyses.
 */
export function startPoller(options: PollerOptions): Poller {
    const schedule = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    const cancel = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

    let handle: unknown = null;
    let inFlight: Promise<void> | null = null;
    let stopped = false;
    let runs = 0;

    async function cycle(): Promise<void> {
        if (stopped) {
            return;
        }

        runs += 1;

        try {
            await options.run();

            options.logger.info(
                { event: 'poller_cycle_completed', intervalMs: options.intervalMs },
                'poller_cycle_completed',
            );
        } catch (error) {
            // A failed cycle is normal — the provider is allowed to be down.
            // The poller exists precisely so that nobody is watching when it
            // happens, and it must keep ticking.
            options.logger.error(
                { event: 'poller_cycle_failed', err: error },
                'poller_cycle_failed',
            );
        }
    }

    function scheduleNext(): void {
        if (stopped) {
            return;
        }

        handle = schedule(() => {
            handle = null;

            if (inFlight !== null) {
                // Still working through the previous cycle. Skip this tick
                // rather than queueing another one behind it.
                options.logger.warn?.(
                    { event: 'poller_cycle_skipped' },
                    'poller_cycle_skipped',
                );

                scheduleNext();

                return;
            }

            startCycle();
        }, options.intervalMs);
    }

    function startCycle(): void {
        inFlight = cycle().finally(() => {
            inFlight = null;
            scheduleNext();
        });
    }

    // The first cycle runs immediately so a freshly started service is warm
    // before anyone asks it anything.
    startCycle();

    return {
        async stop(): Promise<void> {
            stopped = true;

            if (handle !== null) {
                cancel(handle);
                handle = null;
            }

            if (inFlight !== null) {
                await inFlight;
            }
        },

        get isRunning(): boolean {
            return !stopped;
        },

        get completedRuns(): number {
            return runs;
        },
    };
}
