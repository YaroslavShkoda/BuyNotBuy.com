interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface MarketActivityProps {
    candles: Candle[];
}

export default function MarketActivity({
    candles,
}: MarketActivityProps) {
    const visible = candles.slice(-24);

    if (visible.length === 0) {
        return null;
    }

    const first = visible[0]!;
    const last = visible[visible.length - 1]!;

    const high = Math.max(...visible.map((candle) => candle.high));
    const low = Math.min(...visible.map((candle) => candle.low));

    const totalVolume = visible.reduce(
        (sum, candle) => sum + candle.volume,
        0,
    );

    const averageVolume = totalVolume / visible.length;

    const priceChange =
        ((last.close - first.open) / first.open) * 100;

    const range =
        ((high - low) / low) * 100;

    const latestVolumeRatio =
        averageVolume > 0
            ? last.volume / averageVolume
            : 0;

    const formatPrice = (value: number) =>
        value.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });

    const formatVolume = (value: number) => {
        if (value >= 1_000_000) {
            return `${(value / 1_000_000).toFixed(2)}M`;
        }

        if (value >= 1_000) {
            return `${(value / 1_000).toFixed(2)}K`;
        }

        return value.toFixed(0);
    };

    const activityClass =
        latestVolumeRatio >= 1.25
            ? 'high'
            : latestVolumeRatio <= 0.75
              ? 'low'
              : 'normal';

    const changeClass =
        priceChange > 0
            ? 'positive'
            : priceChange < 0
              ? 'negative'
              : 'neutral';

    return (
        <section className="market-activity">
            <div className="market-activity-header">
                <div>
                    <small>04</small>
                    <strong>MARKET ACTIVITY</strong>
                </div>

                <span>24H MARKET WINDOW</span>
            </div>

            <div className="activity-grid">
                <article className="activity-card activity-main">
                    <div className="activity-label">
                        PRICE CHANGE
                    </div>

                    <strong className={`activity-big ${changeClass}`}>
                        {priceChange >= 0 ? '+' : ''}
                        {priceChange.toFixed(2)}%
                    </strong>

                    <div className="activity-range">
                        <div className="range-line">
                            <i
                                style={{
                                    left: `${Math.min(
                                        Math.max(
                                            ((last.close - low) /
                                                (high - low || 1)) *
                                                100,
                                            0,
                                        ),
                                        100,
                                    )}%`,
                                }}
                            />
                        </div>

                        <div className="range-values">
                            <span>${formatPrice(low)}</span>
                            <span>${formatPrice(high)}</span>
                        </div>
                    </div>
                </article>

                <article className="activity-card">
                    <div className="activity-label">
                        SESSION HIGH
                    </div>

                    <strong className="activity-number">
                        ${formatPrice(high)}
                    </strong>

                    <span className="activity-sub">
                        24H HIGH
                    </span>
                </article>

                <article className="activity-card">
                    <div className="activity-label">
                        SESSION LOW
                    </div>

                    <strong className="activity-number">
                        ${formatPrice(low)}
                    </strong>

                    <span className="activity-sub">
                        24H LOW
                    </span>
                </article>

                <article className="activity-card">
                    <div className="activity-label">
                        PRICE RANGE
                    </div>

                    <strong className="activity-number">
                        {range.toFixed(2)}%
                    </strong>

                    <span className="activity-sub">
                        HIGH / LOW SPREAD
                    </span>
                </article>

                <article className="activity-card activity-volume">
                    <div className="activity-label">
                        VOLUME
                    </div>

                    <strong className="activity-number">
                        {formatVolume(totalVolume)}
                    </strong>

                    <div className="volume-status">
                        <i className={activityClass} />
                        <span>
                            {activityClass === 'high'
                                ? 'HIGH ACTIVITY'
                                : activityClass === 'low'
                                  ? 'LOW ACTIVITY'
                                  : 'NORMAL ACTIVITY'}
                        </span>
                    </div>
                </article>

                <article className="activity-card activity-candles">
                    <div className="activity-label">
                        DATA WINDOW
                    </div>

                    <strong className="activity-number">
                        {visible.length}
                    </strong>

                    <span className="activity-sub">
                        HOURLY CANDLES
                    </span>

                    <div className="activity-bars">
                        {visible.slice(-12).map(
                            (candle, index) => {
                                const maxVolume = Math.max(
                                    ...visible
                                        .slice(-12)
                                        .map(
                                            (item) =>
                                                item.volume,
                                        ),
                                );

                                const height =
                                    maxVolume > 0
                                        ? (candle.volume /
                                              maxVolume) *
                                          100
                                        : 0;

                                const positive =
                                    candle.close >=
                                    candle.open;

                                return (
                                    <i
                                        key={`${candle.timestamp}-${index}`}
                                        className={
                                            positive
                                                ? 'positive'
                                                : 'negative'
                                        }
                                        style={{
                                            height: `${Math.max(
                                                height,
                                                8,
                                            )}%`,
                                        }}
                                    />
                                );
                            },
                        )}
                    </div>
                </article>
            </div>
        </section>
    );
}