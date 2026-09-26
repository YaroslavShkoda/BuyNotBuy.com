import type { Candle } from '../types/analysis';

/**
 * Volume bars, with the real number for the bar under the pointer.
 *
 * The bar heights are a ratio against the visible maximum, so the chart answers
 * "which periods were busy" and never "how much". The tooltip carries the second
 * question, and it is the one a reader has while comparing two bars.
 *
 * The tooltip is plain CSS on :hover rather than a hovered index in state. That
 * choice costs forty-eight hidden spans in the markup and buys three things: the
 * chart ships as a server component with nothing to hydrate, the value cannot
 * fail to appear because a script did not run, and the number is in the served
 * HTML where a reader without a pointer can still find it. The same figures are
 * in the activity table lower down the page, which is why the overlay itself is
 * hidden from assistive technology rather than read out bar by bar.
 */

const COMPACT_RU = new Intl.NumberFormat('ru-RU', {
    notation: 'compact',
    maximumFractionDigits: 2,
});

const EXACT_RU = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

interface VolumePlotProps {
    candles: Candle[];
    maxVolume: number;
    barStep: number;
    chartWidth: number;
}

function formatCandleTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export function VolumePlot({ candles, maxVolume, barStep, chartWidth }: VolumePlotProps) {
    return (
        <div
            className="volume-plot"
            role="img"
            aria-label="Объём торгов по периодам"
        >
            <svg viewBox={`0 0 ${chartWidth} 76`} preserveAspectRatio="none" aria-hidden="true">
                {candles.map((candle, index) => {
                    const height = Math.max((candle.volume / maxVolume) * 68, 2);
                    const rising = candle.close >= candle.open;

                    return (
                        <rect
                            key={candle.timestamp}
                            x={index * barStep + barStep * 0.18}
                            y={76 - height}
                            width={Math.max(barStep * 0.62, 1)}
                            height={height}
                            rx="1.5"
                            className={rising ? 'volume-bar rising' : 'volume-bar falling'}
                        />
                    );
                })}
            </svg>

            {/* Hit targets sit over the SVG rather than inside it: a bar is only
                a few pixels wide at 48 candles across the panel, and each target
                is the full height of the plot so it is easy to put a pointer on. */}
            <div className="volume-track" aria-hidden="true">
                {candles.map((candle, index) => (
                    <div
                        key={candle.timestamp}
                        className="volume-hit"
                        style={{
                            left: `${(index / candles.length) * 100}%`,
                            width: `${100 / candles.length}%`,
                        }}
                    >
                        <span className="volume-tooltip">
                            <span className="volume-tooltip-time">
                                {formatCandleTime(candle.timestamp)}
                            </span>
                            <span className="volume-tooltip-value">
                                {EXACT_RU.format(candle.volume)} USDT
                            </span>
                            <span className="volume-tooltip-compact">
                                ≈ {COMPACT_RU.format(candle.volume)} USDT
                            </span>
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
