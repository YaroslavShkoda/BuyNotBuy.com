import { marketConfig } from '../config/market.config.js';
import { findCandleSeriesIssues } from '../market/candle-validation.js';
import { marketDataProvider } from '../market/market.provider.js';
import type { MarketDataProvider } from '../market/providers/market-data.provider.js';
import type { Candle } from '../types/market.js';
import type { CandleRepository, CandleSeriesKey } from './candle.repository.js';
import { candleRepository } from './candle.repository.js';

/**
 * Filling a series backwards from the present.
 *
 * A backfill is the operation most likely to be interrupted, restarted and run
 * twice in a row, and it is the one that talks to a venue thousands of times.
 * Three properties follow, and they are the whole design:
 *
 * it can stop and be picked up where it left off, so the cursor is read from
 * the table rather than kept in memory — a counter is lost with the process,
 * and a counter stored in a row is a second source of truth that can disagree
 * with the data it describes;
 *
 * re-running it is boring, so every page is an idempotent write and a duplicate
 * costs nothing;
 *
 * and it is not the thing that earns a ban, so pages are spaced out and a page
 * that comes back wrong is dropped rather than stored.
 */

export interface BackfillRequest {
    /** Which series to fill. */
    readonly key: CandleSeriesKey;
    /** Stop once this timestamp is covered. Defaults to the oldest bar wanted. */
    readonly until?: number;
    /** Stop after this many bars, for a run with a budget. */
    readonly maxCandles?: number;
    /** Pause between pages. Defaults to the configured gap. */
    readonly pageDelayMs?: number;
    /** Called after every page, for a progress line or a heartbeat. */
    readonly onProgress?: (progress: BackfillProgress) => void;
    /** Injected in tests; defaults to the process-wide repository. */
    readonly repository?: CandleRepository;
    /** Injected in tests; defaults to the configured provider chain. */
    readonly provider?: MarketDataProvider;
    /** Injected in tests. Defaults to the wall clock. */
    readonly now?: () => number;
    /** Injected in tests. Defaults to a plain timer. */
    readonly sleep?: (ms: number) => Promise<void>;
}

export interface BackfillProgress {
    /** Bars written by this run, counting rewrites of existing bars. */
    readonly written: number;
    /**
     * Of those, bars that were **already stored** and have just been
     * overwritten.
     *
     * `bulkUpsert` cannot tell the two apart — it issues one
     * `ON CONFLICT ... DO UPDATE` and returns a single number — so this is
     * counted before the write, by asking which of the fetched timestamps the
     * series already holds.
     *
     * **Why it is worth a query per page.** A backfill is supposed to fill
     * gaps. A bar that was already there is not a gap, and overwriting it
     * changes the inputs under every measurement ever computed from it: the
     * signals, the outcomes, the backtests, the calibration. A run that quietly
     * rewrote four hundred stored bars would leave all of them looking like
     * ordinary history, and nothing downstream could tell that the ground moved
     * under them. A number that cannot distinguish filling a hole from replacing
     * a record understates the difference between the two.
     */
    readonly overwritten: number;
    /** Pages fetched, including the one that came back empty. */
    readonly pages: number;
    /** Newest oldest bar in the table, or null when the series is empty. */
    readonly oldestStored: number | null;
    /** True when the run has nothing left to do. */
    readonly done: boolean;
    /** Bars refused by validation, across the whole run. */
    readonly rejected: number;
}

export type BackfillStopReason =
    | 'target_reached'
    | 'no_more_bars'
    | 'budget_exhausted';

export interface BackfillResult extends BackfillProgress {
    readonly reason: BackfillStopReason;
    /** Bars in the series after the run, forming ones included. */
    readonly total: number;
}

/**
 * The oldest bar in the series, and where the next page has to stop.
 *
 * `getAfter`, not `getBefore`. Asking "give me the newest bar older than the end
 * of time" returns the *newest* bar, which is a cursor that never moves — the
 * walk then re-reads the same page forever, reports progress on every iteration,
 * and cannot finish. Asking "the oldest bar newer than nothing" is the one
 * question whose answer is the bottom of the series.
 *
 * Read from the table every time rather than carried in a variable. That is one
 * query per page, and it is what makes the job resumable by construction: if
 * the process dies, the next run reads the same number and starts there, with
 * nothing to reconcile.
 */
async function oldestStored(
    repository: CandleRepository,
    key: CandleSeriesKey,
): Promise<number | null> {
    const rows = await repository.getAfter(key, 0, 1, { closedOnly: false });

    return rows[0]?.timestamp ?? null;
}

/**
 * The bars of a page that may be stored: well-formed, and not older than the
 * target. Reports how many were refused.
 *
 * The target is enforced per bar rather than per page, because a page is the
 * shape of the request and the target is the shape of the answer. Storing a
 * whole page past the target means "stop here" means "stop somewhere in here,
 * whenever the next page happens to end" — a caller that asked for four years
 * gets four years and a bit, and a caller that asked for a bounded amount has
 * no way to know how much it got.
 *
 * The boundary bar itself is kept. "Until this timestamp" names the bar to
 * finish on, and the bar that sits exactly on it is the one the caller asked
 * for; dropping it on a strict comparison leaves the series a bar short of its
 * own target and turns a finished run into a "no more bars" one.
 *
 * The structural check is the table's own constraint as well, and both are kept
 * because they answer different questions. The constraint protects the table;
 * this keeps one bad bar from costing a whole page, since a backfill of ten
 * thousand bars that loses a thousand to a single malformed response finishes
 * with a history nobody can see is incomplete.
 */
function usableBars(
    page: readonly Candle[],
    now: number,
    oldestWanted: number,
): { bars: Candle[]; rejected: number } {
    const bars: Candle[] = [];
    let rejected = 0;

    for (const candle of page) {
        if (candle.timestamp < oldestWanted) {
            rejected += 1;
            continue;
        }

        const issue = findCandleSeriesIssues([candle], now, 1);

        if (issue === null) {
            bars.push(candle);
            continue;
        }

        rejected += 1;
    }

    return { bars, rejected };
}

export async function runBackfill(
    request: BackfillRequest,
): Promise<BackfillResult> {
    const repository = request.repository ?? candleRepository;
    const provider = request.provider ?? marketDataProvider;
    const now = request.now ?? Date.now;
    const sleep =
        request.sleep ??
        ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const pageSize = marketConfig.backfillPageSize;
    const delayMs = request.pageDelayMs ?? marketConfig.backfillPageDelayMs;
    const target = request.until ?? marketConfig.backfillFrom;
    const budget = request.maxCandles;

    let written = 0;
    let overwritten = 0;
    let pages = 0;
    let rejected = 0;
    let reason: BackfillStopReason = 'target_reached';

    for (;;) {
        if (budget !== undefined && written >= budget) {
            reason = 'budget_exhausted';
            break;
        }

        const oldest = await oldestStored(repository, request.key);

        if (oldest !== null && oldest <= target) {
            // Already covered. A second run of a finished backfill costs one
            // read and stops, which is what makes it safe to schedule.
            break;
        }

        // Undefined means "from the present", which is only right when the
        // table is empty. Once there is a bar, the cursor is the oldest one —
        // otherwise every page is the same thousand newest bars and the job
        // reports progress forever without ever reaching history.
        const before = oldest ?? undefined;
        const remaining = budget === undefined ? pageSize : budget - written;
        const limit = Math.max(1, Math.min(pageSize, remaining));

        const page = await provider.getHistoricalCandles(limit, before);
        pages += 1;

        if (page.length === 0) {
            reason = 'no_more_bars';
            break;
        }

        const usable = usableBars(page, now(), target);

        rejected += usable.rejected;

        if (usable.bars.length > 0) {
            // Asked before the write: afterwards every bar is present, and the
            // question would answer "all of them" every time.
            //
            // The bounds are a min and a max, **not** the first and last bar.
            // A backfill walks backwards, so a page arrives newest-first, and
            // `[newest, oldest]` is an inverted range: `getRange` returned
            // nothing, the overlap came back as zero, and the report said
            // "0 overwritten" over three bars it had just replaced. A counter
            // that reads zero when the thing it measures happened is worse than
            // no counter, because it is believed.
            let lowest = usable.bars[0]?.timestamp ?? 0;
            let highest = lowest;

            for (const bar of usable.bars) {
                if (bar.timestamp < lowest) {
                    lowest = bar.timestamp;
                }

                if (bar.timestamp > highest) {
                    highest = bar.timestamp;
                }
            }

            const already = await repository.getRange(request.key, lowest, highest);
            const present = new Set(already.map((bar) => bar.timestamp));

            for (const bar of usable.bars) {
                if (present.has(bar.timestamp)) {
                    overwritten += 1;
                }
            }

            written += await repository.bulkUpsert(request.key, usable.bars);
        }

        const afterPage = await oldestStored(repository, request.key);

        const done = afterPage !== null && afterPage <= target;

        request.onProgress?.({
            written,
            overwritten,
            pages,
            oldestStored: afterPage,
            done,
            rejected,
        });

        if (done) {
            break;
        }

        // A page that left the bottom of the series where it found it is a venue
        // repeating itself, whether because the page was unusable or because the
        // cursor was ignored. The providers guard against this inside one call;
        // a backfill runs for hours across thousands of calls, and a loop that
        // cannot end is worse than one that stops short and says so.
        if (afterPage === oldest) {
            reason = 'no_more_bars';
            break;
        }

        if (delayMs > 0) {
            await sleep(delayMs);
        }
    }

    return {
        written,
        overwritten,
        pages,
        oldestStored: await oldestStored(repository, request.key),
        done: true,
        rejected,
        reason,
        total: await repository.count(request.key, { closedOnly: false }),
    };
}
