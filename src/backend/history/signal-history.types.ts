import type { IndicatorSignal } from '../signals/signal.types';

export interface SignalHistoryEntry {
    timestamp: number;
    symbol: string;
    signal: IndicatorSignal;
    consensus: number;
    price: number;
}

export interface SignalHistoryLogger {
    warn(context: Record<string, unknown>, message: string): void;
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
    changes24h: number;
    lastTransition: SignalHistoryLastTransition | null;
    previousDurationHours: number | null;
    previousDurationBounded: boolean;
    sampleHours: number;
}
