'use client';

import { useMemo, useState } from 'react';

interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface MarketChartProps {
    candles: Candle[];
    ema: number;
}

type Timeframe = '1H' | '4H' | '1D' | '1W' | '1M';

const WIDTH = 1000;
const HEIGHT = 360;

const PADDING = {
    top: 25,
    right: 75,
    bottom: 42,
    left: 10,
};

function calculateEma(values: number[], period: number) {
    if (values.length === 0) {
        return [];
    }

    const multiplier = 2 / (period + 1);

    let previous = values[0] ?? 0;

    return values.map((value, index) => {
        if (index === 0) {
            return previous;
        }

        previous =
            (value - previous) * multiplier + previous;

        return previous;
    });
}

function formatPrice(value: number) {
    return value.toLocaleString('en-US', {
        maximumFractionDigits: 0,
    });
}

function formatTime(timestamp: number) {
    return new Date(timestamp).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
    });
}

export default function MarketChart({
    candles,
    ema,
}: MarketChartProps) {
    const [timeframe, setTimeframe] =
        useState<Timeframe>('1H');

    const [hoveredIndex, setHoveredIndex] =
        useState<number | null>(null);

    const visibleCandles = useMemo(() => {
        if (candles.length === 0) {
            return [];
        }

        const limits: Record<Timeframe, number> = {
            '1H': 48,
            '4H': 96,
            '1D': 168,
            '1W': 300,
            '1M': 300,
        };

        return candles.slice(
            -Math.min(limits[timeframe], candles.length),
        );
    }, [candles, timeframe]);

    const chartData = useMemo(() => {
        if (visibleCandles.length === 0) {
            return null;
        }

        const highs = visibleCandles.map(
            (candle) => candle.high,
        );

        const lows = visibleCandles.map(
            (candle) => candle.low,
        );

        const closes = visibleCandles.map(
            (candle) => candle.close,
        );

        const rawMax = Math.max(...highs);
        const rawMin = Math.min(...lows);

        const range = rawMax - rawMin || 1;
        const padding = range * 0.08;

        const max = rawMax + padding;
        const min = rawMin - padding;

        const chartWidth =
            WIDTH - PADDING.left - PADDING.right;

        const chartHeight =
            HEIGHT - PADDING.top - PADDING.bottom;

        const xStep =
            chartWidth /
            Math.max(visibleCandles.length - 1, 1);

        const getX = (index: number) =>
            PADDING.left + index * xStep;

        const getY = (price: number) =>
            PADDING.top +
            ((max - price) / (max - min)) *
                chartHeight;

        const emaValues = calculateEma(closes, 300);

        const emaPoints = emaValues
            .filter(
                (value): value is number =>
                    value !== undefined,
            )
            .map(
                (value, index) =>
                    `${getX(index)},${getY(value)}`,
            );

        return {
            max,
            min,
            getX,
            getY,
            xStep,
            emaPoints,
        };
    }, [visibleCandles]);

    if (!chartData || visibleCandles.length === 0) {
        return (
            <div className="market-chart-empty">
                <span>NO MARKET DATA</span>
                <small>AWAITING CANDLE DATA</small>
            </div>
        );
    }

    const currentCandle =
        visibleCandles[visibleCandles.length - 1];

    if (!currentCandle) {
        return null;
    }

    const currentPrice = currentCandle.close;

    const hoveredCandle =
        hoveredIndex !== null
            ? visibleCandles[hoveredIndex]
            : null;

    const horizontalLevels = 5;

    return (
        <div className="market-chart">
            <div className="chart-header">
                <div>
                    <span>PRICE / USDT</span>
                    <strong>
                        ${formatPrice(currentPrice)}
                    </strong>
                </div>

                {hoveredCandle && (
                    <div className="chart-tooltip">
                        <span>
                            {new Date(
                                hoveredCandle.timestamp,
                            ).toLocaleString('ru-RU')}
                        </span>

                        <strong>
                            O {formatPrice(hoveredCandle.open)}
                            {'  '}
                            H {formatPrice(hoveredCandle.high)}
                            {'  '}
                            L {formatPrice(hoveredCandle.low)}
                            {'  '}
                            C {formatPrice(hoveredCandle.close)}
                        </strong>
                    </div>
                )}
            </div>

            <div className="chart-svg-wrap">
                <svg
                    viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                    preserveAspectRatio="none"
                    className="market-chart-svg"
                    onMouseLeave={() =>
                        setHoveredIndex(null)
                    }
                >
                    <defs>
                        <linearGradient
                            id="chart-area"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                        >
                            <stop
                                offset="0%"
                                stopColor="white"
                                stopOpacity="0.06"
                            />

                            <stop
                                offset="100%"
                                stopColor="white"
                                stopOpacity="0"
                            />
                        </linearGradient>
                    </defs>

                    {Array.from({
                        length: horizontalLevels,
                    }).map((_, index) => {
                        const ratio =
                            index /
                            (horizontalLevels - 1);

                        const y =
                            PADDING.top +
                            ratio *
                                (HEIGHT -
                                    PADDING.top -
                                    PADDING.bottom);

                        const value =
                            chartData.max -
                            ratio *
                                (chartData.max -
                                    chartData.min);

                        return (
                            <g key={`level-${index}`}>
                                <line
                                    x1={PADDING.left}
                                    x2={
                                        WIDTH -
                                        PADDING.right
                                    }
                                    y1={y}
                                    y2={y}
                                    stroke="#181818"
                                    strokeWidth="1"
                                />

                                <text
                                    x={
                                        WIDTH -
                                        PADDING.right +
                                        12
                                    }
                                    y={y + 3}
                                    fill="#444"
                                    fontSize="10"
                                >
                                    {formatPrice(value)}
                                </text>
                            </g>
                        );
                    })}

                    {visibleCandles.map(
                        (candle, index) => {
                            const x =
                                chartData.getX(index);

                            const openY =
                                chartData.getY(
                                    candle.open,
                                );

                            const closeY =
                                chartData.getY(
                                    candle.close,
                                );

                            const highY =
                                chartData.getY(
                                    candle.high,
                                );

                            const lowY =
                                chartData.getY(
                                    candle.low,
                                );

                            const bullish =
                                candle.close >=
                                candle.open;

                            const bodyTop =
                                Math.min(
                                    openY,
                                    closeY,
                                );

                            const bodyHeight =
                                Math.max(
                                    Math.abs(
                                        closeY -
                                            openY,
                                    ),
                                    1.5,
                                );

                            const candleWidth =
                                Math.max(
                                    chartData.xStep *
                                        0.55,
                                    2,
                                );

                            return (
                                <g
                                    key={
                                        candle.timestamp
                                    }
                                    className={
                                        hoveredIndex ===
                                        index
                                            ? 'candle hovered'
                                            : 'candle'
                                    }
                                    onMouseEnter={() =>
                                        setHoveredIndex(
                                            index,
                                        )
                                    }
                                >
                                    <line
                                        x1={x}
                                        x2={x}
                                        y1={highY}
                                        y2={lowY}
                                        stroke={
                                            bullish
                                                ? '#b8b8b8'
                                                : '#555'
                                        }
                                        strokeWidth="1"
                                    />

                                    <rect
                                        x={
                                            x -
                                            candleWidth /
                                                2
                                        }
                                        y={bodyTop}
                                        width={
                                            candleWidth
                                        }
                                        height={
                                            bodyHeight
                                        }
                                        fill={
                                            bullish
                                                ? '#dcdcdc'
                                                : '#3b3b3b'
                                        }
                                    />
                                </g>
                            );
                        },
                    )}

                    <polyline
                        points={
                            chartData.emaPoints.join(' ')
                        }
                        fill="none"
                        stroke="#ffffff"
                        strokeOpacity="0.55"
                        strokeWidth="2"
                    />

                    <line
                        x1={PADDING.left}
                        x2={
                            WIDTH -
                            PADDING.right
                        }
                        y1={chartData.getY(
                            currentPrice,
                        )}
                        y2={chartData.getY(
                            currentPrice,
                        )}
                        stroke="#ffffff"
                        strokeOpacity="0.22"
                        strokeDasharray="5 5"
                    />

                    <circle
                        cx={
                            chartData.getX(
                                visibleCandles.length -
                                    1,
                            )
                        }
                        cy={chartData.getY(
                            currentPrice,
                        )}
                        r="4"
                        fill="#fff"
                        className="current-price-dot"
                    />
                </svg>
            </div>

            <div className="chart-bottom">
                <div className="chart-time-labels">
                    {visibleCandles.length > 0 && (
                        <>
                            <span>
                                {formatTime(
                                    visibleCandles.at(0)?.timestamp ?? 0,
                                )}
                            </span>

                            <span>
                                {formatTime(
                                    visibleCandles.at(
                                        Math.floor(
                                            visibleCandles.length / 2,
                                        ),
                                    )?.timestamp ?? 0,
                                )}
                            </span>

                            <span>
                                {formatTime(
                                    visibleCandles.at(-1)?.timestamp ?? 0,
                                )}
                            </span>
                        </>
                    )}
                </div>

                <div className="chart-legend">
                    <span>
                        <i className="legend-candle" />
                        PRICE
                    </span>

                    <span>
                        <i className="legend-ema" />
                        EMA 300
                    </span>
                </div>
            </div>

            <div className="chart-timeframes">
                {(
                    ['1H', '4H', '1D', '1W', '1M'] as Timeframe[]
                ).map((item) => (
                    <button
                        key={item}
                        className={
                            timeframe === item
                                ? 'selected'
                                : ''
                        }
                        onClick={() =>
                            setTimeframe(item)
                        }
                    >
                        {item}
                    </button>
                ))}
            </div>
        </div>
    );
}