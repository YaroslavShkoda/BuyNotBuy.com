import type { IndicatorSignal } from '../signals/signal.types.js';

export interface SignalHistoryEntry {
    timestamp: number;
    symbol: string;
    signal: IndicatorSignal;
    consensus: number;
    price: number;
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
