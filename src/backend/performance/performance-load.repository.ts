/**
 * Reads what was published next to what the market did, for one market.
 *
 * The performance layer computes honestly and had no way to be asked. This is
 * the reader that asks it, and it exists mostly to answer one question
 * correctly: **where does a confidence come from?**
 *
 * Not from the outcome. An outcome row knows how the market went and nothing
 * about what the system claimed at the time, and the claim is the thing being
 * measured. The join below reaches into `signal_state` for the confidence as
 * published, and takes the regime from the outcome row because the publisher
 * wrote it there at publication time — both of them are prior readings, and
 * both travel forward as prior readings.
 *
 * A row with no `signal_state` is dropped and counted. It cannot be
 * calibrated, because there is nothing in it that was claimed: counting it
 * would add a sample with no claim, and a table of claims would then report on
 * a population that includes rows nobody ever spoke about.
 */

import { query } from '../db/pool.js';

import type { SignalOutcome } from '../outcomes/outcome.js';
import type { OutcomeWithPublication } from './samples.js';

export interface PerformanceSeriesKey {
    readonly symbol: string;
    readonly provider: string;
    readonly interval: string;
}

export interface PerformanceLoad {
    /**
     * How many rows to read.
     *
     * Bounded on purpose. A report over an unbounded history is a report over
     * the table, and a table grows whether or not anyone is still asking.
     */
    readonly limit: number;
}

interface RawRow {
    readonly id: string;
    readonly signal_state_id: number | null;
    readonly symbol: string;
    readonly entry_timestamp: number;
    readonly entry_price: number;
    readonly direction: 'LONG' | 'SHORT';
    readonly verdict: SignalOutcome['horizons'][number]['verdict'];
    readonly horizon_bars: number;
    readonly return_fraction: number | null;
    readonly max_favourable: number | null;
    readonly max_adverse: number | null;
    readonly closed_by: SignalOutcome['closedBy'];
    readonly regime: string | null;
    readonly confidence: number | null;
}

/**
 * The identity of a signal, for the purpose of counting it once.
 *
 * **`id` is not it.** `id` is this table's primary key, one per row per horizon,
 * so a signal measured at three horizons has three different ids. Grouping by
 * it would count that signal three times in a table that measures one horizon —
 * and every number in such a table is arithmetically correct, because it is
 * counting three real rows. The uniqueness that matters is the one the schema
 * already declares: `(symbol, provider, interval, signal_state_id,
 * horizon_bars)`, which is a signal identified by which signal it was.
 *
 * A row with no `signal_state_id` belongs to no signal, so it stands alone.
 * Each is then counted as a claim nobody made, which is what it is.
 */
function groupKey(row: RawRow): string {
    return row.signal_state_id === null
        ? `unclaimed:${row.id}`
        : `signal:${row.signal_state_id}`;
}

/**
 * Groups rows into signals and pairs each with what was published.
 *
 * Rows for other horizons are not grouped at all: this measures one horizon, and
 * a signal measured at 8 bars says nothing about its 24 bar reading.
 */
export function groupIntoSignals(
    rows: readonly RawRow[],
    horizonBars: number,
): { signals: OutcomeWithPublication[]; withoutClaim: number } {
    const bySignal = new Map<string, RawRow[]>();

    for (const row of rows) {
        if (row.horizon_bars !== horizonBars) {
            continue;
        }

        const key = groupKey(row);
        const group = bySignal.get(key);

        if (group === undefined) {
            bySignal.set(key, [row]);
        } else {
            group.push(row);
        }
    }

    const signals: OutcomeWithPublication[] = [];
    let withoutClaim = 0;

    for (const group of bySignal.values()) {
        const first = group[0];

        if (first === undefined) {
            continue;
        }

        if (first.confidence === null) {
            withoutClaim += 1;

            continue;
        }

        signals.push({
            outcome: {
                symbol: first.symbol,
                entryTimestamp: first.entry_timestamp,
                entryPrice: first.entry_price,
                direction: first.direction,
                horizons: group.map((row) => ({
                    bars: row.horizon_bars,
                    returnFraction: row.return_fraction,
                    maxFavourable: row.max_favourable,
                    maxAdverse: row.max_adverse,
                    verdict: row.verdict,
                })),
                closedBy: first.closed_by,
            },
            published: { confidence: first.confidence, regime: first.regime },
        });
    }

    return { signals, withoutClaim };
}

/**
 * Every measured signal for one market at one horizon, oldest first.
 *
 * The caller still decides whether the rows are far enough in the past to
 * count, and that decision is deliberately not made here: it belongs in
 * `toPerformanceSamples`, which also accounts for what it leaves out. A query
 * that filtered on the date would report a table over its own idea of "now"
 * and leave the reader believing the sample was complete.
 */
export async function loadMeasuredSignals(
    key: PerformanceSeriesKey,
    horizonBars: number,
    load: PerformanceLoad = { limit: 5_000 },
): Promise<{ signals: OutcomeWithPublication[]; withoutClaim: number; read: number }> {
    const result = await query<RawRow>(
        `SELECT o.id,
                o.signal_state_id,
                o.symbol,
                o.entry_timestamp,
                o.entry_price,
                o.direction,
                o.verdict,
                o.horizon_bars,
                o.return_fraction,
                o.max_favourable,
                o.max_adverse,
                o.closed_by,
                o.regime,
                s.confidence
           FROM signal_outcome o
           LEFT JOIN signal_state s ON s.id = o.signal_state_id
          WHERE o.symbol = $1
            AND o.provider = $2
            AND o.interval = $3
          ORDER BY o.entry_timestamp ASC
          LIMIT $4`,
        [key.symbol, key.provider, key.interval, load.limit],
    );

    const { signals, withoutClaim } = groupIntoSignals(result.rows, horizonBars);

    return { signals, withoutClaim, read: result.rows.length };
}
