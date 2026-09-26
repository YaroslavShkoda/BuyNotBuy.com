import { VolumePlot } from './volume-plot';
import { buildVolumeScale } from '../lib/volume-scale';
import { summariseVolume } from '../lib/volume-summary';
import { quoteAssetOf } from '../lib/quote-asset';

import type { Candle } from '../types/analysis';

interface MarketChartProps {
    candles: Candle[];
    symbol: string;
    ema300: number;
}

const chartWidth = 900;
const chartHeight = 250;

export function getVisibleCandles(candles: Candle[]): Candle[] {
    return candles.filter(
        (candle) =>
    Number.isFinite(candle.timestamp) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.volume),
    ).slice(-48);
}

export function computeChartScale(
    closes: number[],
    ema300: number | null,
): { low: number; high: number; span: number } {
    const values = [...closes, ...(ema300 !== null && Number.isFinite(ema300) ? [ema300] : [])];

    if (values.length === 0) {
        return { low: 0, high: 0, span: 1 };
    }

    const low = Math.min(...values);
    const high = Math.max(...values);
    return { low, high, span: high - low || 1 };
}

export function getCandleIntervalMs(candles: Candle[]): number | null {
    let min: number | null = null;

    for (let index = 1; index < candles.length; index += 1) {
        const previous = candles[index - 1];
        const current = candles[index];

        if (previous === undefined || current === undefined) continue;

        const delta = current.timestamp - previous.timestamp;

        if (Number.isFinite(delta) && delta > 0 && (min === null || delta < min)) {
    min = delta;
        }
    }

    return min;
}

export function getWindowMs(candles: Candle[]): number | null {
    const first = candles[0];
    const last = candles.at(-1);

    if (candles.length < 2 || first === undefined || last === undefined) {
        return null;
    }

    const interval = getCandleIntervalMs(candles);

    if (interval === null) return null;

    const windowMs = last.timestamp - first.timestamp + interval;

    return Number.isFinite(windowMs) && windowMs > 0 ? windowMs : null;
}

export function getWindowLabel(candles: Candle[]): string | null {
    const windowMs = getWindowMs(candles);

    if (windowMs === null) return null;

    const minutes = windowMs / 60000;

    if (minutes < 60) return `${Math.max(Math.round(minutes), 1)} мин`;
    if (minutes <= 48 * 60) return `${Math.round(windowMs / 3600000)} ч`;
    return `${Math.round(windowMs / 86400000)} дн`;
}

export function formatAxisTime(timestamp: number, windowMs: number): string {
    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) return '—';

    return windowMs >= 24 * 3600000
        ? date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The volumes behind the bars, as figures rather than as shapes.
 *
 * The bar heights are ratios — each hour against its own recent past — which is
 * what lets the panel survive the venue changing underneath it. The cost is that
 * a bar's height no longer says how much was traded, so these four numbers put
 * the amounts back underneath.
 *
 * Compact notation, not the full digits: the point is a glance at how the window
 * compares with itself, and `2,1 млн` is read faster than `2 143 907`. The exact
 * value is one hover away on the bar itself.
 */
const COMPACT_VOLUME = new Intl.NumberFormat('ru-RU', {
    notation: 'compact',
    maximumFractionDigits: 2,
});

const VOLUME_TIME = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
});

// A Russian decimal comma, which `toFixed` does not give: the panel would show
// "×3.7" beside "171,28 млн" and read like two different number systems.
const RATIO = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
});

function VolumeStats({ candles, symbol }: { candles: Candle[]; symbol: string }) {
    const summary = summariseVolume(candles);

    if (summary.count === 0) {
        return null;
    }

    const when = (timestamp: number | undefined) =>
        timestamp === undefined ? '—' : VOLUME_TIME.format(timestamp);

    return (
        <div className="volume-stats">
            <div className="volume-stat">
                <span className="volume-stat-label">МАКСИМУМ</span>
                <strong>{COMPACT_VOLUME.format(summary.max?.value ?? 0)}</strong>
                <small>{when(summary.max?.timestamp)}</small>
            </div>

            <div className="volume-stat">
                <span className="volume-stat-label">МИНИМУМ</span>
                <strong>{COMPACT_VOLUME.format(summary.min?.value ?? 0)}</strong>
                <small>{when(summary.min?.timestamp)}</small>
            </div>

            <div className="volume-stat">
                <span className="volume-stat-label">СРЕДНЕЕ</span>
                <strong>{COMPACT_VOLUME.format(summary.average)}</strong>
                <small>за {summary.count} ч</small>
            </div>

            <div className="volume-stat">
                <span className="volume-stat-label">МЕДИАНА</span>
                <strong>{COMPACT_VOLUME.format(summary.median)}</strong>
                <small>типичный час</small>
            </div>

            {/* The one figure that is scale-free: it reads the same on a quiet
                market and a frantic one, which is what makes it a judgement
                rather than a number to remember. */}
            <div className="volume-stat">
                <span className="volume-stat-label">ПИК</span>
                <strong>
                    {summary.peakRatio > 0
                        ? `×${RATIO.format(summary.peakRatio)}`
                        : '—'}
                </strong>
                <small>к среднему</small>
            </div>

            <div className="volume-stat">
                <span className="volume-stat-label">ВСЕГО</span>
                <strong>{COMPACT_VOLUME.format(summary.total)}</strong>
                <small>{quoteAssetOf(symbol)}</small>
            </div>
        </div>
    );
}

export function MarketChart({ candles, symbol, ema300 }: MarketChartProps) {
    const visibleCandles = getVisibleCandles(candles);
    const closes = visibleCandles.map((candle) => candle.close);
    const hasEma = Number.isFinite(ema300);
    const { low, high, span } = computeChartScale(closes, hasEma ? ema300 : null);
    // Reserve horizontal padding so the end-of-line price marker (r≈4) is not
    // clipped by the card's overflow:hidden at the right edge.
    const markerPad = 8;
    const plotWidth = chartWidth - markerPad * 2;
    const points = closes.map((close, index) => ({
        x: markerPad + (index / Math.max(closes.length - 1, 1)) * plotWidth,
        y: chartHeight - ((close - low) / span) * (chartHeight - 24) - 12,
    }));
    const line = points.map(({ x, y }, index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ');
    const area = `${line} L ${chartWidth} ${chartHeight} L 0 ${chartHeight} Z`;
    const volumeScale = buildVolumeScale(visibleCandles);
    const barStep = chartWidth / Math.max(visibleCandles.length, 1);
    const last = visibleCandles.at(-1);
    const first = visibleCandles[0];
    const change = visibleCandles.length > 1 && first !== undefined && last !== undefined && first.close !== 0
        ? ((last.close - first.close) / first.close) * 100
        : 0;
    const windowMs = getWindowMs(visibleCandles) ?? 0;
    const windowLabel = getWindowLabel(visibleCandles);
    const emaY = chartHeight - ((ema300 - low) / span) * (chartHeight - 24) - 12;
    const emaLabelTop = Math.min(Math.max((emaY / chartHeight) * 100, 4), 94);

    if (visibleCandles.length === 0) {
        return (
    <section className="chart-card depth-surface" aria-label="График рынка">
        <div className="chart-heading">
            <div>
                <span className="eyebrow">PRICE ACTION</span>
                <h2>Движение рынка</h2>
            </div>
        </div>

        <p className="table-empty">Нет данных по свечам</p>
    </section>
        );
    }

    return (
        <section className="chart-card depth-surface" aria-label="График рынка">
    <div className="chart-heading">
        <div>
            <span className="eyebrow">
                PRICE ACTION{windowLabel !== null ? ` · ПОСЛЕДНИЕ ${windowLabel.toUpperCase()}` : ''}
            </span>
            <h2>Движение рынка</h2>
        </div>
        <div className="chart-summary">
                            <span className={change >= 0 ? 'chart-change positive' : 'chart-change negative'}>
                                {change >= 0 ? '+' : ''}{change.toFixed(2)}% <span>{windowLabel !== null ? `за ${windowLabel} · ` : ''}{symbol}</span>
                            </span>
                        </div>
    </div>
    <div className="chart-plot">
        <div className="chart-axis-labels" aria-hidden="true">
            <span>{high.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
            <span>{((high + low) / 2).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
            <span>{low.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
        </div>
        <div className="chart-plot-surface">
            <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" role="img" aria-label={`График цены${windowLabel !== null ? ` за последние ${windowLabel}` : ''} с уровнем EMA 300`}>
                <defs>
                    <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8ae3b7" stopOpacity=".24" />
                        <stop offset="100%" stopColor="#8ae3b7" stopOpacity="0" />
                    </linearGradient>
                </defs>
                {[0.08, 0.5, 0.92].map((position) => <line key={position} x1="0" x2={chartWidth} y1={chartHeight * position} y2={chartHeight * position} className="chart-gridline" />)}
                {hasEma && (
                    <line x1="0" x2={chartWidth} y1={emaY} y2={emaY} className="chart-ema-line" />
                )}
                <path d={area} fill="url(#chart-fill)" />
                <path d={line} className="chart-line" />
            </svg>
            {points.length > 0 && (
                <span
                    className="chart-marker"
                    style={{
                        left: `${(points.at(-1)!.x / chartWidth) * 100}%`,
                        top: `${(points.at(-1)!.y / chartHeight) * 100}%`,
                    }}
                    aria-hidden="true"
                />
            )}
        </div>
        {hasEma && (
            <span className="chart-ema-label" style={{ top: `${emaLabelTop}%` }}>
                EMA 300 · ${ema300.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </span>
        )}
    </div>
    <div className="chart-time-labels">
        <span>{first !== undefined ? formatAxisTime(first.timestamp, windowMs) : '—'}</span>
        <span>Сейчас</span>
    </div>
    <div className="volume-heading">
        <span>ОБЪЁМ ТОРГОВ</span>
        <span>{quoteAssetOf(symbol)}</span>
    </div>
        <VolumePlot
            candles={visibleCandles}
            scale={volumeScale}
            symbol={symbol}
            barStep={barStep}
            chartWidth={chartWidth}
        />
        <VolumeStats candles={visibleCandles} symbol={symbol} />
        </section>
    );
}
