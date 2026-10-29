import type { MarketAnalysis } from '../types/analysis';

export function SnapshotStrip({ label, snapshot, now = Date.now() }: {
    label: 'График' | 'Анализ';
    snapshot?: MarketAnalysis['snapshot'];
    now?: number;
}) {
    if (snapshot === undefined) return (
        <div className="snapshot-strip" data-freshness="unknown" aria-label={`${label}: источник и актуальность`}>
            {label}: источник и актуальность — API не сообщает
        </div>
    );
    const age = Math.floor(Math.max(0, now - snapshot.lastBarClosedAt) / 60_000);
    const closedAt = new Date(snapshot.lastBarClosedAt).toISOString();
    return (
        <div className="snapshot-strip" data-freshness={snapshot.freshness} aria-label={`${label}: источник и актуальность`}>
            <span>{label} · {snapshot.provider} · {snapshot.symbol} · {snapshot.interval}</span>
            <span className="snapshot-freshness">{snapshot.freshness}{snapshot.stale ? ' · повтор после сбоя' : ''}</span>
            <span className="snapshot-time">Свеча закрыта <time dateTime={closedAt}>{closedAt}</time> · возраст {age} мин на момент загрузки</span>
        </div>
    );
}
