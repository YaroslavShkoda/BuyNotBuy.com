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
// available sample of hourly snapshots. Durations count recorded hours, never
// interpolating across gaps; the bounded flags mark runs that may extend
// beyond the sample ("at least N hours").
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
}