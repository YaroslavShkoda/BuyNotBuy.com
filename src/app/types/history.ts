// Frontend view of backend contract (src/backend/api/schemas.ts).
// Keep field-compatible with backend SignalHistoryEntry / summary DTOs.
import type { IndicatorSignal } from './analysis';

export interface SignalHistoryEntry {
    timestamp: number;
    symbol: string;
    signal: IndicatorSignal;
    consensus: number;
    price: number;
}

export interface SignalHistoryLastTransition {
    from: IndicatorSignal;
    to: IndicatorSignal;
    timestamp: number;
}

// Mirrors backend SignalHistorySummary: stability context derived from the
// available sample of hourly snapshots. Durations are elapsed hours measured
// from timestamps, not a record count; the bounded flags mark runs that may
// extend beyond the sample ("at least N hours"). `changes24h` really is
// restricted to the last 24 hours, and `sampleHours` is the elapsed span.
export interface HistorySummary {
    currentSignal: IndicatorSignal | null;
    currentDurationHours: number | null;
    currentDurationBounded: boolean;
    changes24h: number;
    lastTransition: SignalHistoryLastTransition | null;
    previousDurationHours: number | null;
    previousDurationBounded: boolean;
    sampleHours: number;
}

export interface SignalHistoryResponse {
    entries: SignalHistoryEntry[];
    summary: HistorySummary;
    /**
     * Where the next, older page starts, or null at the end of the record.
     *
     * Carried so the type mirrors the backend contract even though the panel
     * asks for one page: an opaque cursor is not something a client can build
     * by hand, so it is only ever useful echoed back to the server.
     */
    nextCursor: string | null;
}