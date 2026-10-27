import { describe, expect, it } from 'vitest';
import { evaluateHistoricalIntegrity, supportedHistoricalSeries } from './historical-integrity.js';

const key = { provider: 'binance', symbol: 'BTCUSDT', interval: '1h' as const };
const start = 1_699_999_200_000;
const clean = { ...key, count: 3, closedCount: 3, oldest: start, newest: start + 7_200_000,
    duplicateCount: 0, gapCount: 0, misalignedCount: 0, identityMismatchCount: 0, invalidCount: 0,
    unknownProvenanceCount: 0, provenanceMismatchCount: 0, volumeAnomalyCount: 0 };
const options = { now: start + 10_800_000, from: start, to: start + 7_200_000 };

describe('historical activation integrity', () => {
    it('enumerates every declared venue/symbol/interval, including empty series', () => {
        expect(supportedHistoricalSeries([{ venue: 'binance', instruments: ['BTCUSDT', 'ETHUSDT'], intervals: ['1h', '15m'] }])).toHaveLength(4);
    });
    it('permits a complete attributed series without any price-range heuristic', () => {
        expect(evaluateHistoricalIntegrity(key, clean, options).activationAllowed).toBe(true);
    });
    it.each([
        ['duplicateCount', 'duplicate_timestamp'], ['gapCount', 'timestamp_gap'],
        ['misalignedCount', 'timestamp_misaligned'], ['identityMismatchCount', 'instrument_mismatch'],
        ['unknownProvenanceCount', 'provenance_unknown'], ['provenanceMismatchCount', 'provenance_mismatch'],
        ['invalidCount', 'invalid_candle'],
    ])('blocks activation for %s even when prices would look normal', (field, reason) => {
        const report = evaluateHistoricalIntegrity(key, { ...clean, [field]: 1 }, options);
        expect(report.activationAllowed).toBe(false);
        expect(report.blockers).toContain(reason);
    });
    it('blocks absent or partial coverage and stale closed data', () => {
        expect(evaluateHistoricalIntegrity(key, undefined, options).blockers).toContain('empty_series');
        expect(evaluateHistoricalIntegrity(key, { ...clean, oldest: start + 3_600_000 }, options).blockers).toContain('coverage_incomplete');
        expect(evaluateHistoricalIntegrity(key, clean, { ...options, now: options.now + 10_800_000 }).blockers).toContain('stale_series');
    });
    it('warns on volume anomalies without claiming cross-venue price differences prove contamination', () => {
        const report = evaluateHistoricalIntegrity(key, { ...clean, volumeAnomalyCount: 1 }, options);
        expect(report.warnings).toContain('volume_anomaly');
        expect(report.activationAllowed).toBe(true);
    });
    it('fails closed when freshness or requested window is invalid', () => {
        expect(() => evaluateHistoricalIntegrity(key, clean, { ...options, now: Number.NaN })).toThrow();
        expect(() => evaluateHistoricalIntegrity(key, clean, { ...options, from: options.to + 1 })).toThrow();
    });
    it('does not allow malformed inventory numbers or a future closed bar to yield GO', () => {
        expect(evaluateHistoricalIntegrity(key, { ...clean, gapCount: Number.NaN }, options).blockers).toContain('invalid_inventory');
        expect(evaluateHistoricalIntegrity(key, { ...clean, newest: Number.NaN }, options).blockers).toContain('invalid_inventory');
        expect(evaluateHistoricalIntegrity(key, { ...clean, newest: options.now + 3_600_000 }, options).blockers).toContain('future_closed_bar');
    });
});
