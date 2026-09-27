import type { IndicatorSignal } from '../signals/signal.types.js';

/**
 * The series a history row belongs to.
 *
 * Part of the identity rather than a column that happens to be there. The
 * original primary key was the symbol and the hour, which is uniqueness over
 * too little: the moment a second interval is analysed for the same symbol,
 * every write for it collides with the first one's row and overwrites it, and
 * the history silently becomes whichever series wrote last.
 */
export interface SignalHistorySeries {
    symbol: string;
    provider: string;
    interval: string;
}

/**
 * What was true when a signal was published.
 *
 * Nullable throughout, and that is the point rather than a shortfall. A row
 * recorded before any of this existed has no regime and no quality
 * assessment, and saying so is honest where reconstructing a value would be a
 * guess dressed as a measurement. The performance engine filters on these
 * columns and counts what it could not group, rather than grouping everything
 * into "unknown" and reporting a number that means nothing.
 */
export interface SignalContext {
    regime: string | null;
    dataQuality: number | null;
    dataQualityUsable: boolean | null;
    dataQualityWorst: string | null;
}

export interface SignalHistoryEntry {
    timestamp: number;
    symbol: string;
    /**
     * Optional, and defaulted by the repository to the configured series.
     *
     * A caller that has never heard of a second interval should not have to
     * say so on every write, and a series that is not named is the configured
     * one. What the field may not be is *ambiguous* — hence the default rather
     * than an open nullable.
     */
    provider?: string;
    interval?: string;
    signal: IndicatorSignal;
    consensus: number;
    price: number;
    context?: SignalContext;
}

export interface SignalHistoryLogger {
    warn(context: Record<string, unknown>, message: string): void;
    /** Optional: not every caller in the codebase is a pino logger. */
    debug?(context: Record<string, unknown>, message: string): void;
}

export interface SignalHistoryLastTransition {
    from: IndicatorSignal;
    to: IndicatorSignal;
    timestamp: number;
}

// History intelligence: metrics derived from the available sample of hourly
// snapshots. Durations count consecutive same-signal hourly records, never
// interpolating across gaps, so they undercount rather than overclaim.
export interface SignalHistorySummary {
    currentSignal: IndicatorSignal | null;
    currentDurationHours: number | null;
    currentDurationBounded: boolean;
    /**
     * How many of those hours were actually observed.
     *
     * `currentDurationHours` is elapsed time between the newest record and the
     * first record of the run, so a process that was down for an hour in the
     * middle of a stable stretch makes the stretch *look* longer, not shorter.
     * That is the safe direction for a duration, and it is still a claim the
     * dashboard should not make alone: "the signal has held for 40 hours" over
     * 38 observations and one missing hour is a different sentence from the
     * same 40 over 40. Reported alongside it rather than folded into it, so
     * neither number has to be interpreted by the reader.
     */
    currentObservedHours: number | null;
    /**
     * Missing hourly buckets inside the current run, for the same reason.
     * The live database had exactly one of these: hour 497344 was absent from
     * both the history and the vote table, which is what a backlog dying with
     * its process looks like from the data side.
     */
    currentGaps: number;
    changes24h: number;
    lastTransition: SignalHistoryLastTransition | null;
    previousDurationHours: number | null;
    previousDurationBounded: boolean;
    sampleHours: number;
}
