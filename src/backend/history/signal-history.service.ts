import { marketConfig } from '../config/market.config';

import { getSignalHistoryRepository } from './signal-history.repository';

import type {
    SignalHistoryEntry,
    SignalHistoryLastTransition,
    SignalHistoryLogger,
    SignalHistorySummary,
} from './signal-history.types';

// History is a non-critical subsystem: a persistence failure must never
// propagate into the market analysis path, so this wrapper is fail-open
// by contract and never throws.
export function recordSignalHistory(
    entry: SignalHistoryEntry,
    logger?: SignalHistoryLogger,
): void {
    try {
        getSignalHistoryRepository().record(entry);
    } catch (error) {
        logger?.warn(
            {
                event: 'signal_history_record_failed',
                err: error,
            },
            'signal_history_record_failed',
        );
    }
}

export function getSignalHistory(limit: number): SignalHistoryEntry[] {
    return getSignalHistoryRepository().list(marketConfig.symbol, limit);
}

// History intelligence: derives stability context from the available sample of
// hourly snapshots. The sample arrives newest-first.
//
// Semantics (deliberately conservative — the API only claims what the records
// actually show):
//   - Durations count consecutive same-signal hourly records (buckets), never
//     interpolating across missing hours. "N hours" means "N recorded hourly
//     snapshots", so gaps make the number undercount rather than overclaim.
//   - A run is "bounded" when an older record with a different signal exists,
//     i.e. the run start is visible in the sample. An unbounded run means the
//     true duration may be longer ("at least N hours").
//   - changes24h counts adjacent record pairs with differing signals within
//     the sample; lastTransition is the newest such pair (from = older state,
//     to = newer state) with the timestamp of the newer record.

const EMPTY_SUMMARY: SignalHistorySummary = {
    currentSignal: null,
    currentDurationHours: null,
    currentDurationBounded: false,
    changes24h: 0,
    lastTransition: null,
    previousDurationHours: null,
    previousDurationBounded: false,
    sampleHours: 0,
};

export function summarizeHistory(
    entries: SignalHistoryEntry[],
): SignalHistorySummary {
    if (entries.length === 0) {
        return EMPTY_SUMMARY;
    }

    // entries is non-empty, but noUncheckedIndexedAccess types the element
    // as possibly undefined, so the guard keeps the access narrow.
    const newest = entries[0];

    if (newest === undefined) {
        return EMPTY_SUMMARY;
    }

    const currentSignal = newest.signal;

    // Current run: consecutive same-signal records starting from the newest.
    let currentRun = 0;
    while (currentRun < entries.length && entries[currentRun]?.signal === currentSignal) {
        currentRun += 1;
    }

    // Transitions: entries are newest-first, so entries[i] is newer than
    // entries[i + 1]; a pair differs when their signals differ.
    let changes24h = 0;
    let transitionIndex: number | undefined;

    for (let i = 0; i < entries.length - 1; i += 1) {
        if (entries[i]?.signal !== entries[i + 1]?.signal) {
            changes24h += 1;
            transitionIndex ??= i;
        }
    }

    let lastTransition: SignalHistoryLastTransition | null = null;
    let previousDurationHours: number | null = null;
    let previousDurationBounded = false;

    if (transitionIndex !== undefined) {
        const newer = entries[transitionIndex];
        const older = entries[transitionIndex + 1];

        if (newer !== undefined && older !== undefined) {
            lastTransition = {
                from: older.signal,
                to: newer.signal,
                timestamp: newer.timestamp,
            };

            // Previous run: consecutive same-signal records after the
            // transition, going back toward older records.
            const previousSignal = older.signal;
            let previousRun = 0;
            let cursor = transitionIndex + 1;

            while (cursor < entries.length && entries[cursor]?.signal === previousSignal) {
                previousRun += 1;
                cursor += 1;
            }

            previousDurationHours = previousRun;
            previousDurationBounded = cursor < entries.length;
        }
    }

    return {
        currentSignal,
        currentDurationHours: currentRun,
        currentDurationBounded: currentRun < entries.length,
        changes24h,
        lastTransition,
        previousDurationHours,
        previousDurationBounded,
        sampleHours: entries.length,
    };
}
