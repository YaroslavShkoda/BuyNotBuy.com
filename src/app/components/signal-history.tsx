import type { IndicatorSignal } from '../types/analysis';
import type { SignalHistoryEntry, SignalHistoryResponse } from '../types/history';
import { formatUpdatedAt } from './topbar';
import { HistorySummary } from './history-summary';

export interface SignalHistoryRow {
    id: number;
    time: string;
    signal: IndicatorSignal;
    consensus: string;
    isTransition: boolean;
}

// The API contract guarantees the entry shape, but a malformed backend
// response must degrade to an empty list instead of crashing the page.
export function isValidHistoryEntry(value: unknown): value is SignalHistoryEntry {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const entry = value as Partial<SignalHistoryEntry>;

    return typeof entry.timestamp === 'number'
        && Number.isFinite(entry.timestamp)
        && entry.timestamp > 0
        && typeof entry.symbol === 'string'
        && entry.symbol.length > 0
        && (entry.signal === 'LONG' || entry.signal === 'SHORT' || entry.signal === 'NEUTRAL')
        && typeof entry.consensus === 'number'
        && Number.isFinite(entry.consensus)
        && typeof entry.price === 'number'
        && Number.isFinite(entry.price);
}

export function filterValidEntries(entries: unknown): SignalHistoryEntry[] {
    return Array.isArray(entries)
        ? entries.filter(isValidHistoryEntry)
        : [];
}

export function getSignalHistoryRows(
    entries: SignalHistoryEntry[],
    now: Date = new Date(),
): SignalHistoryRow[] {
    // Entries arrive newest-first; a row marks a transition when its signal
    // differs from the row above (the newer state).
    return entries.map((entry, index) => {
        const previous = index > 0 ? entries[index - 1] : undefined;
        const consensus = Math.min(100, Math.max(0, Math.round(entry.consensus)));

        return {
            id: entry.timestamp,
            time: formatUpdatedAt(entry.timestamp, now),
            signal: entry.signal,
            consensus: `${consensus}%`,
            isTransition: previous !== undefined && previous.signal !== entry.signal,
        };
    });
}

interface SignalHistoryProps {
    data: SignalHistoryResponse | null;
}

export function SignalHistory({ data }: SignalHistoryProps) {
    const entries = data === null ? [] : filterValidEntries(data.entries);

    return (
        <section className="signal-history" aria-label="История сигнала">
            <div className="signal-history-header">
                <span className="eyebrow">ИСТОРИЯ СИГНАЛОВ</span>
                <span className="signal-history-note">КОНСЕНСУС</span>
            </div>

            {data === null ? (
                <p className="signal-history-empty">
                    История временно недоступна
                </p>
            ) : entries.length === 0 ? (
                <p className="signal-history-empty">
                    История сигнала пока отсутствует
                </p>
            ) : (
                <>
                    <HistorySummary summary={data.summary} />
                    <ul className="signal-history-list">
                        {getSignalHistoryRows(entries).map((row) => (
                            <li
                                className="signal-history-row"
                                key={row.id}
                                data-signal={row.signal.toLowerCase()}
                                data-transition={row.isTransition ? 'true' : undefined}
                            >
                                <span className="signal-history-time">{row.time}</span>
                                <strong className="signal-history-signal">{row.signal}</strong>
                                <span className="signal-history-consensus">{row.consensus}</span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </section>
    );
}
