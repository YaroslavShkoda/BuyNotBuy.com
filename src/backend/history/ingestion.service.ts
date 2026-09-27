import { marketConfig } from '../config/market.config.js';
import { startPoller } from '../services/poller.js';
import { candleRepository } from './candle.repository.js';
import { isCandleClosed, ingestionPeriodMs } from './candle-clock.js';
import { marketDataProvider } from '../market/market.provider.js';

import type { Poller, PollerLogger } from '../services/poller.js';
import type { CandleSeriesKey, CandleRepository } from './candle.repository.js';
import type { MarketDataProvider } from '../market/providers/market-data.provider.js';
import type { Candle } from '../types/market.js';

/**
 * Keeping the candle table current.
 *
 * The table is the reference every later measurement is taken against, and it
 * only stays a reference if it is complete. A table filled once at deploy and
 * never again is a snapshot, and a snapshot quietly turns into a gap the first
 * time the service is not restarted for a week — at which point the gap is
 * indistinguishable from a quiet market, and every statistic computed over it
 * says the same confident, wrong thing.
 *
 * So this runs on its own clock, writes the forming bar as well as the closed
 * ones, and never trusts its own memory about what it last stored: the cursor
 * is read from the table, because a counter in a process that can be restarted
 * at any moment is a number nobody can rely on.
 */

export interface IngestionResult {
    /**
     * Rows written, including a row that was already stored with the same
     * values. A poller that ticks every few minutes against hourly bars
     * rewrites the same finished bars most of the time, and reporting that as
     * nine changes would be a counter nobody could read.
     */
    readonly written: number;
    /** Of those, the bars that had already been finished. */
    readonly closedWritten: number;
    /** Of those, the bars that were still forming. */
    readonly formingWritten: number;
    /** Bars the table refused to change — a finished bar offered back as forming. */
    readonly skipped: number;
    /** The forming bar's timestamp, or null when the venue returned none. */
    readonly forming: number | null;
    /** Bars the venue returned. */
    readonly fetched: number;
}

export interface IngestionOptions {
    readonly key: CandleSeriesKey;
    readonly intervalMs: number;
    /** Injected in tests. Defaults to the wall clock. */
    readonly now?: () => number;
    readonly repository?: CandleRepository;
    readonly provider?: MarketDataProvider;
    /** How many recent bars to ask for. */
    readonly limit?: number;
}

export interface IngestionSchedulerOptions extends IngestionOptions {
    readonly logger: PollerLogger;
    /** Upper bound on the poll period. */
    readonly maxPeriodMs?: number;
    readonly pollEnabled?: boolean;
    readonly setTimer?: (handler: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Fetches the newest bars and splits them by what they are.
 *
 * The forming bar is stored too, and that is the deliberate half of the design
 * most likely to be questioned. It exists so the dashboard can show the candle
 * currently forming, and it is written with `is_closed` false so every reader
 * that measures something can leave it out. Dropping it instead would mean the
 * newest hour is missing from the chart for its whole duration, which is
 * exactly the hour a user is watching.
 */
export async function ingestOnce(
    options: IngestionOptions,
): Promise<IngestionResult> {
    const repository = options.repository ?? candleRepository;
    const provider = options.provider ?? marketDataProvider;
    const now = options.now ?? Date.now;
    const limit = options.limit ?? marketConfig.defaultCandleLimit;
    const at = now();

    const fetched = await provider.getHistoricalCandles(limit);

    if (fetched.length === 0) {
        return {
            written: 0,
            closedWritten: 0,
            formingWritten: 0,
            skipped: 0,
            forming: null,
            fetched: 0,
        };
    }

    const bars = splitByAge(options.intervalMs, fetched, at);

    let closedWritten = 0;
    let formingWritten = 0;
    let skipped = 0;

    for (const bar of bars.closed) {
        // `true` for isClosed: a bar that is finished must not be stored as
        // forming, and the repository defaults to that.
        if (await repository.upsert(options.key, bar, { isClosed: true })) {
            closedWritten += 1;
        } else {
            skipped += 1;
        }
    }

    for (const bar of bars.forming) {
        if (await repository.upsert(options.key, bar, { isClosed: false })) {
            formingWritten += 1;
        }
    }

    return {
        written: closedWritten + formingWritten,
        closedWritten,
        formingWritten,
        skipped,
        forming: bars.forming.at(-1)?.timestamp ?? null,
        fetched: fetched.length,
    };
}

/**
 * Splits a fetched series into what is finished and what is still moving.
 *
 * Splitting here rather than in the repository keeps the clock question out of
 * the storage layer: a repository asked to store a bar should not have to know
 * what time it is to decide whether that bar is real yet.
 */
function splitByAge(
    intervalMs: number,
    fetched: readonly Candle[],
    at: number,
): { closed: Candle[]; forming: Candle[] } {
    const closed: Candle[] = [];
    const forming: Candle[] = [];

    for (const bar of fetched) {
        if (isCandleClosed({ intervalMs }, bar.timestamp, at)) {
            closed.push(bar);
            continue;
        }

        forming.push(bar);
    }

    return { closed, forming };
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

/** The series the ingest loop fills, from the configured venue and symbol. */
export function configuredSeries(): CandleSeriesKey {
    return {
        provider: marketConfig.provider,
        symbol: marketConfig.symbol,
        interval: marketConfig.candleInterval,
    };
}
