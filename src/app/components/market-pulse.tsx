interface MarketPulseProps {
    price: number;
    ema: number;
    stochastic: number;
    signal: 'LONG' | 'SHORT' | 'NEUTRAL';
    confidence: number;
    emaSignal?: 'LONG' | 'SHORT' | 'NEUTRAL' | undefined;
    stochasticSignal?: 'LONG' | 'SHORT' | 'NEUTRAL' | undefined;
}

export default function MarketPulse({
    price,
    ema,
    stochastic,
    signal,
    confidence,
    emaSignal,
    stochasticSignal,
}: MarketPulseProps) {
    const signalClass = signal.toLowerCase();

    const emaDistance = ((price - ema) / ema) * 100;

    const oscillatorZone =
        stochastic >= 80
            ? 'OVERBOUGHT'
            : stochastic <= 20
              ? 'OVERSOLD'
              : 'NEUTRAL';

    const oscillatorClass =
        stochastic >= 80
            ? 'negative'
            : stochastic <= 20
              ? 'positive'
              : 'warning';

    const formatNumber = (value: number) =>
        value.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });

    return (
        <section className="market-pulse" id="market-analysis">
            <div className="market-pulse-header">
                <div>
                    <strong>MARKET PULSE</strong>
                </div>

                <span>
                    LIVE MARKET INTELLIGENCE
                </span>
            </div>

            <div className="pulse-grid">
                <article className={`pulse-card ${signalClass}`}>
                    <div className="pulse-card-top">
                        <span>DIRECTION</span>

                        <i className="pulse-status-dot" />
                    </div>

                    <strong className="pulse-value">
                        {signal}
                    </strong>

                    <div className="pulse-meta">
                        <span>CONSENSUS</span>
                        <strong>{confidence}%</strong>
                    </div>

                    <div className="pulse-progress">
                        <i
                            style={{
                                width: `${Math.min(
                                    Math.max(confidence, 0),
                                    100,
                                )}%`,
                            }}
                        />
                    </div>
                </article>

                <article className="pulse-card">
                    <div className="pulse-card-top">
                        <span>PRICE / EMA 300</span>
                        <span className="pulse-index">01</span>
                    </div>

                    <strong className="pulse-number">
                        {emaDistance >= 0 ? '+' : ''}
                        {emaDistance.toFixed(2)}%
                    </strong>

                    <div className="pulse-detail">
                        <span>PRICE</span>
                        <strong>${formatNumber(price)}</strong>
                    </div>

                    <div className="pulse-detail">
                        <span>EMA 300</span>
                        <strong>${formatNumber(ema)}</strong>
                    </div>

                    <div className="pulse-bar">
                        <i
                            className={
                                emaDistance >= 0
                                    ? 'positive'
                                    : 'negative'
                            }
                        />
                    </div>
                </article>

                <article className="pulse-card">
                    <div className="pulse-card-top">
                        <span>OSCILLATOR</span>
                        <span className="pulse-index">02</span>
                    </div>

                    <strong
                        className={`pulse-number ${oscillatorClass}`}
                    >
                        {stochastic.toFixed(2)}
                    </strong>

                    <div className="oscillator-scale">
                        <div className="oscillator-track">
                            <i
                                style={{
                                    left: `${Math.min(
                                        Math.max(stochastic, 0),
                                        100,
                                    )}%`,
                                }}
                            />
                        </div>

                        <div>
                            <span>0</span>
                            <span>50</span>
                            <span>100</span>
                        </div>
                    </div>

                    <div className="pulse-zone">
                        <span>ZONE</span>
                        <strong className={oscillatorClass}>
                            {oscillatorZone}
                        </strong>
                    </div>
                </article>

                <article className="pulse-card consensus-card">
                    <div className="pulse-card-top">
                        <span>SIGNAL MATRIX</span>
                        <span className="pulse-index">03</span>
                    </div>

                    <div className="signal-matrix">
                        <div>
                            <span>EMA 300</span>
                            <strong className={emaSignal?.toLowerCase()}>
                                {emaSignal ?? '—'}
                            </strong>
                        </div>

                        <div>
                            <span>STOCHASTIC</span>
                            <strong
                                className={
                                    stochasticSignal?.toLowerCase()
                                }
                            >
                                {stochasticSignal ?? '—'}
                            </strong>
                        </div>
                    </div>

                    <div className={`matrix-result ${signalClass}`}>
                        <i />
                        <span>CONSENSUS</span>
                        <strong>{signal}</strong>
                    </div>
                </article>
            </div>
        </section>
    );
}
