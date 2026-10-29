import type { VenueCapability } from '../market/capability.js';
import { CANDLE_INTERVAL_MS } from '../types/candle-interval.js';
import type { CandleSeriesKey } from './candle.repository.js';

export interface HistoricalSeriesInventory extends CandleSeriesKey {
    count: number;
    closedCount: number;
    oldest: number | null;
    newest: number | null;
    duplicateCount: number;
    gapCount: number;
    misalignedCount: number;
    identityMismatchCount: number;
    invalidCount: number;
    unknownProvenanceCount: number;
    provenanceMismatchCount: number;
    volumeAnomalyCount: number;
}
export interface IntegrityWindow { now: number; from: number; to: number }
export interface HistoricalIntegrityReport {
    key: CandleSeriesKey;
    inventory: HistoricalSeriesInventory | null;
    activationAllowed: boolean;
    blockers: string[];
    warnings: string[];
}
export function supportedHistoricalSeries(capabilities: readonly VenueCapability[]): CandleSeriesKey[] {
    const keys = new Map<string, CandleSeriesKey>();
    for (const capability of capabilities) {
        for (const symbol of capability.instruments) {
            for (const interval of capability.intervals) {
                const key = { provider: capability.venue, symbol, interval };
                keys.set(JSON.stringify(key), key);
            }
        }
    }
    return [...keys.values()];
}
export function evaluateHistoricalIntegrity(key: CandleSeriesKey, inventory: HistoricalSeriesInventory | undefined, window: IntegrityWindow): HistoricalIntegrityReport {
    if (![window.now, window.from, window.to].every(Number.isSafeInteger) || window.from > window.to || window.to >= window.now) {
        throw new Error('Integrity window must contain ordered, closed timestamps and a finite clock');
    }
    const blockers: string[] = [];
    const warnings: string[] = [];
    const step = CANDLE_INTERVAL_MS[key.interval];
    if (!step) throw new Error('Unsupported historical interval');
    if (!inventory || inventory.closedCount === 0) {
        blockers.push('empty_series');
    } else {
        const checks = [
            ['duplicateCount', 'duplicate_timestamp'], ['gapCount', 'timestamp_gap'],
            ['misalignedCount', 'timestamp_misaligned'], ['identityMismatchCount', 'instrument_mismatch'],
            ['unknownProvenanceCount', 'provenance_unknown'], ['provenanceMismatchCount', 'provenance_mismatch'],
            ['invalidCount', 'invalid_candle'],
        ] as const;
        if (inventory.closedCount > inventory.count ||
            ![inventory.oldest, inventory.newest].every((value) => value !== null && Number.isSafeInteger(value) && value >= 0) ||
            (inventory.oldest !== null && inventory.newest !== null && inventory.oldest > inventory.newest) ||
            ['count', 'closedCount', 'volumeAnomalyCount', ...checks.map(([field]) => field)].some((field) => {
            const value = inventory[field as keyof HistoricalSeriesInventory];
            return typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0;
        })) blockers.push('invalid_inventory');
        for (const [field, reason] of checks) if (inventory[field] > 0) blockers.push(reason);
        if (inventory.provider !== key.provider || inventory.symbol !== key.symbol || inventory.interval !== key.interval) blockers.push('series_mismatch');
        if (inventory.oldest === null || inventory.newest === null || inventory.oldest > window.from || inventory.newest < window.to) blockers.push('coverage_incomplete');
        if (inventory.newest === null || window.now - inventory.newest > step * 2) blockers.push('stale_series');
        if (inventory.newest !== null && inventory.newest + step > window.now) blockers.push('future_closed_bar');
        if (inventory.volumeAnomalyCount > 0) warnings.push('volume_anomaly');
    }
    return { key, inventory: inventory ?? null, activationAllowed: blockers.length === 0, blockers, warnings };
}
