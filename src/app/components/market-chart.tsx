import type { Candle } from '../types/analysis';

interface MarketChartProps {
    candles: Candle[];
    symbol: string;
}

const chartWidth = 900;
const chartHeight = 250;

export function MarketChart({ candles, symbol }: MarketChartProps) {
    const visibleCandles = candles.slice(-48);
    const closes = visibleCandles.map((candle) => candle.close);
    const low = closes.length ? Math.min(...closes) : 0;
    const high = closes.length ? Math.max(...closes) : 0;
    const span = high - low || 1;
    const points = closes.map((close, index) => ({
        x: (index / Math.max(closes.length - 1, 1)) * chartWidth,
        y: chartHeight - ((close - low) / span) * (chartHeight - 24) - 12,
    }));
    const line = points.map(({ x, y }, index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ');
    const area = `${line} L ${chartWidth} ${chartHeight} L 0 ${chartHeight} Z`;
    const maxVolume = Math.max(...visibleCandles.map((candle) => candle.volume), 1);
    const barStep = chartWidth / Math.max(visibleCandles.length, 1);
    const last = visibleCandles.at(-1);
    const first = visibleCandles[0];
    const change = visibleCandles.length > 1 && first !== undefined && last !== undefined
        ? ((last.close - first.close) / first.close) * 100
        : 0;

    return (
        <section className="chart-card depth-surface" aria-label="График рынка">
            <div className="chart-heading">
                <div>
                    <span className="eyebrow">PRICE ACTION · 48 ПЕРИОДОВ</span>
                    <h2>Движение рынка</h2>
                </div>
                <div className="chart-summary">
                    <strong>{last?.close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '—'}</strong>
                    <span className={change >= 0 ? 'chart-change positive' : 'chart-change negative'}>
                        {change >= 0 ? '+' : ''}{change.toFixed(2)}% <span>· {symbol}</span>
                    </span>
                </div>
            </div>
            <div className="chart-plot">
                <div className="chart-axis-labels" aria-hidden="true">
                    <span>{high.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                    <span>{((high + low) / 2).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                    <span>{low.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                </div>
                <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" role="img" aria-label="График цены за последние 48 периодов">
                    <defs>
                        <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#8ae3b7" stopOpacity=".24" />
                            <stop offset="100%" stopColor="#8ae3b7" stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    {[0.08, 0.5, 0.92].map((position) => <line key={position} x1="0" x2={chartWidth} y1={chartHeight * position} y2={chartHeight * position} className="chart-gridline" />)}
                    <path d={area} fill="url(#chart-fill)" />
                    <path d={line} className="chart-line" />
                    {points.length > 0 && <circle cx={points.at(-1)!.x} cy={points.at(-1)!.y} r="4" className="chart-marker" />}
                </svg>
            </div>
            <div className="chart-time-labels"><span>48 периода назад</span><span>Сейчас</span></div>
            <div className="volume-heading"><span>ОБЪЁМ ТОРГОВ</span><span>VOLUME</span></div>
            <div className="volume-plot" role="img" aria-label="Объём торгов по периодам">
                <svg viewBox={`0 0 ${chartWidth} 76`} preserveAspectRatio="none" aria-hidden="true">
                    {visibleCandles.map((candle, index) => {
                        const barHeight = Math.max((candle.volume / maxVolume) * 68, 2);
                        const rising = candle.close >= candle.open;
                        return <rect key={candle.timestamp} x={index * barStep + barStep * 0.18} y={76 - barHeight} width={Math.max(barStep * 0.62, 1)} height={barHeight} rx="1.5" className={rising ? 'volume-bar rising' : 'volume-bar falling'} />;
                    })}
                </svg>
            </div>
        </section>
    );
}
