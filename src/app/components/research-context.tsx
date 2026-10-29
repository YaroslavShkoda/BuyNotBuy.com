import { CANDLE_INTERVAL_MS, type CandleInterval } from '../../backend/types/candle-interval';
import type { MarketAnalysis } from '../types/analysis';

export function candleFreshness(lastBar: number | undefined, interval: CandleInterval, now: number): { ageMs: number } | null {
    return lastBar === undefined ? null : { ageMs: Math.max(0, now - lastBar - CANDLE_INTERVAL_MS[interval]) };
}

export function ResearchContext({ interval, timestamp, lastBar, snapshot, explanation, direction, label = 'Анализ', now = Date.now() }: {
    interval: CandleInterval;
    timestamp: number;
    lastBar: number | undefined;
    snapshot?: MarketAnalysis['snapshot'];
    explanation?: MarketAnalysis['explanation'];
    direction?: MarketAnalysis['signal']['signal'];
    label?: string;
    now?: number;
}) {
    const closedAt = snapshot?.lastBarClosedAt ?? (lastBar === undefined ? undefined : lastBar + CANDLE_INTERVAL_MS[interval]);
    const ageMs = closedAt === undefined ? null : Math.max(0, now - closedAt);
    return (
        <section className="research-context depth-surface" aria-label="Контекст исследования и качество данных">
            <h2>{label}: происхождение и ограничения</h2>
            <dl>
                <div><dt>Источник и биржа</dt><dd>{snapshot === undefined ? 'Источник и биржа: API не сообщает' : `${snapshot.provider} · ${snapshot.symbol}`}</dd></div>
                <div><dt>Интервал</dt><dd>{snapshot?.interval ?? interval}</dd></div>
                <div><dt>{label === 'График' ? 'Страница сформирована (UTC)' : 'Анализ рассчитан (UTC)'}</dt><dd><time dateTime={new Date(timestamp).toISOString()}>{new Date(timestamp).toISOString()}</time></dd></div>
                <div><dt>Последняя свеча закрыта (UTC)</dt><dd>{closedAt === undefined ? 'API не сообщает' : <time dateTime={new Date(closedAt).toISOString()}>{new Date(closedAt).toISOString()}</time>}</dd></div>
                <div><dt>Возраст закрытой свечи на момент загрузки</dt><dd>{ageMs === null ? 'Неизвестен' : `${Math.floor(ageMs / 60_000)} мин`}</dd></div>
                <div><dt>Состояние данных API</dt><dd>{snapshot === undefined ? 'API не сообщает stale/degraded' : `${snapshot.freshness} · повтор после сбоя (stale): ${snapshot.stale ? 'да' : 'нет'}`}</dd></div>
            </dl>
            <p>fresh — актуальный снимок; provider_failed — сбой источника при актуальном снимке; stale — устаревший снимок после сбоя; partially_available — неполная история (degraded).</p>
            {label === 'Анализ' && <>
                <p>Консенсус — согласие индикаторов, не вероятность успеха. {explanation?.confidence.meaning} {explanation === undefined ? 'Модель консенсуса API не сообщает.' : `Модель: ${explanation.confidence.model}.`}</p>
                <p>{direction === undefined ? '' : `Опубликованное направление: ${direction}. `}{explanation?.quality == null ? 'Оценку качества API не сообщает. NEUTRAL означает отсутствие направления; это не подтверждение безопасности. Отдельный HOLD API не возвращает.' : `Диагностическая оценка качества: ${explanation.quality.score}; пригодность: ${explanation.quality.usable ? 'да' : 'нет'}. Причины непригодности: ${explanation.quality.blockedBy.join(', ') || 'нет'}. Худший фактор: ${explanation.quality.worst ?? 'нет'}. Эта оценка не блокирует публикацию направления автоматически и не является вето. HOLD API не возвращает; итог и причина показаны в сигнале.`}</p>
                <p>Только для исследования. Это не инвестиционная рекомендация и не обещание прибыли. Статистически устойчивое преимущество над buy-and-hold не подтверждено; сравнивать результаты следует на одном периоде с учётом комиссий, проскальзывания и риска. Прошлая доходность не гарантирует будущую.</p>
            </>}
        </section>
    );
}
