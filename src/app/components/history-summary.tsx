import type { IndicatorSignal } from '../types/analysis';
import type { HistorySummary } from '../types/history';

function isSignal(value: unknown): value is IndicatorSignal {
    return value === 'LONG' || value === 'SHORT' || value === 'NEUTRAL';
}

function isNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidTransition(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const transition = value as {
        from?: unknown;
        to?: unknown;
        timestamp?: unknown;
    };

    return isSignal(transition.from)
        && isSignal(transition.to)
        && typeof transition.timestamp === 'number'
        && Number.isFinite(transition.timestamp);
}

// The API contract guarantees the summary shape, but a malformed backend
// response must degrade to a hidden summary instead of crashing the page.
export function isValidSummary(value: unknown): value is HistorySummary {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const summary = value as {
        currentSignal?: unknown;
        currentDurationHours?: unknown;
        currentDurationBounded?: unknown;
        changes24h?: unknown;
        lastTransition?: unknown;
        previousDurationHours?: unknown;
        previousDurationBounded?: unknown;
        sampleHours?: unknown;
    };

    return (summary.currentSignal === null || isSignal(summary.currentSignal))
        && (summary.currentDurationHours === null
            || (isNonNegativeNumber(summary.currentDurationHours)
                && Number.isInteger(summary.currentDurationHours)))
        && typeof summary.currentDurationBounded === 'boolean'
        && isNonNegativeNumber(summary.changes24h)
        && Number.isInteger(summary.changes24h)
        && (summary.lastTransition === null || isValidTransition(summary.lastTransition))
        && (summary.previousDurationHours === null
            || (isNonNegativeNumber(summary.previousDurationHours)
                && Number.isInteger(summary.previousDurationHours)))
        && typeof summary.previousDurationBounded === 'boolean'
        && isNonNegativeNumber(summary.sampleHours)
        && Number.isInteger(summary.sampleHours);
}

// "N Ч" for a bounded run, "N+ Ч" when the run may extend beyond the sample.
export function formatDurationHours(
    hours: number | null,
    bounded: boolean,
): string {
    if (hours === null) {
        return '—';
    }

    const rounded = Math.max(0, Math.round(hours));

    return bounded ? `${rounded} Ч` : `${rounded}+ Ч`;
}

// The metrics cover the available sample, which may be shorter than 24 hours.
export function getChangesWindowLabel(sampleHours: number): string {
    const hours = Math.max(0, Math.round(sampleHours));

    return hours >= 24 ? '24 Ч' : `${hours} Ч`;
}

interface HistorySummaryProps {
    summary: HistorySummary | null;
}

export function HistorySummary({ summary }: HistorySummaryProps) {
    if (summary === null || !isValidSummary(summary)) {
        return null;
    }

    const transition = summary.lastTransition;

    return (
        <dl className="history-summary" aria-label="Сводка истории сигнала">
            <div
                className="history-summary-row"
                data-signal={summary.currentSignal?.toLowerCase()}
            >
                <dt className="history-summary-label">ТЕКУЩИЙ СИГНАЛ</dt>
                <dd className="history-summary-value">
                    {summary.currentSignal ?? '—'}
                </dd>
            </div>

            <div className="history-summary-row">
                <dt className="history-summary-label">ДЕРЖИТСЯ</dt>
                <dd className="history-summary-value">
                    {formatDurationHours(
                        summary.currentDurationHours,
                        summary.currentDurationBounded,
                    )}
                </dd>
            </div>

            <div className="history-summary-row">
                <dt className="history-summary-label">
                    {`СМЕН · ${getChangesWindowLabel(summary.sampleHours)}`}
                </dt>
                <dd className="history-summary-value">
                    {summary.changes24h}
                </dd>
            </div>

            <div className="history-summary-row">
                <dt className="history-summary-label">ПОСЛЕДНЯЯ СМЕНА</dt>
                <dd className="history-summary-value">
                    {transition === null ? (
                        <span className="history-summary-muted">
                            СМЕН НЕ БЫЛО
                        </span>
                    ) : (
                        <span className="history-summary-transition">
                            <strong className={`history-summary-signal-${transition.from.toLowerCase()}`}>
                                {transition.from}
                            </strong>
                            {' → '}
                            <strong className={`history-summary-signal-${transition.to.toLowerCase()}`}>
                                {transition.to}
                            </strong>
                            {summary.previousDurationHours !== null && (
                                <span className="history-summary-prev-duration">
                                    {` · ${formatDurationHours(
                                        summary.previousDurationHours,
                                        summary.previousDurationBounded,
                                    )}`}
                                </span>
                            )}
                        </span>
                    )}
                </dd>
            </div>
        </dl>
    );
}