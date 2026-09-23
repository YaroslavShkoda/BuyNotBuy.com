interface Indicator {
    name: string;
    signal: 'LONG' | 'SHORT' | 'NEUTRAL';
    reason: string;
}

interface TechnicalAnalysisProps {
    ema: number;
    stochastic: number;
    price: number;
    indicators: Indicator[];
}

export default function TechnicalAnalysis({
    ema,
    stochastic,
    price,
    indicators,
}: TechnicalAnalysisProps) {
    const emaIndicator = indicators.find(
        (indicator) =>
            indicator.name.toLowerCase().includes('ema'),
    );

    const stochasticIndicator = indicators.find(
        (indicator) =>
            /stoch|стох/i.test(indicator.name)
    );

    const emaDistance = ((price - ema) / ema) * 100;

    const emaClass =
        emaDistance > 0
            ? 'long'
            : emaDistance < 0
              ? 'short'
              : 'neutral';

    const stochasticClass =
        stochastic >= 80
            ? 'short'
            : stochastic <= 20
              ? 'long'
              : 'neutral';

    const stochasticZone =
        stochastic >= 80
            ? 'OVERBOUGHT'
            : stochastic <= 20
              ? 'OVERSOLD'
              : 'NEUTRAL';

    const formatPrice = (value: number) =>
        value.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });

    return (
        <section className="technical-analysis">
            <div className="technical-header">
                <div>
                    <small>05</small>
                    <strong>TECHNICAL ANALYSIS</strong>
                </div>

                <span>MODEL INPUTS</span>
            </div>

            <div className="technical-grid">
                <article className={`technical-card ${emaClass}`}>
                    <div className="technical-card-heading">
                        <span>EMA 300</span>
                        <i />
                    </div>

                    <div className="technical-main-value">
                        <strong>
                            {emaDistance >= 0 ? '+' : ''}
                            {emaDistance.toFixed(2)}%
                        </strong>

                        <span>
                            PRICE VS EMA
                        </span>
                    </div>

                    <div className="technical-prices">
                        <div>
                            <span>PRICE</span>
                            <strong>
                                ${formatPrice(price)}
                            </strong>
                        </div>

                        <div>
                            <span>EMA 300</span>
                            <strong>
                                ${formatPrice(ema)}
                            </strong>
                        </div>
                    </div>

                    <div className="technical-track">
                        <i
                            style={{
                                left: `${Math.min(
                                    Math.max(
                                        50 +
                                            emaDistance *
                                                8,
                                        5,
                                    ),
                                    95,
                                )}%`,
                            }}
                        />
                    </div>

                    <div className="technical-reason">
                        <span>SIGNAL</span>

                        <strong
                            className={
                                emaIndicator?.signal.toLowerCase()
                            }
                        >
                            {emaIndicator?.signal ?? 'NEUTRAL'}
                        </strong>
                    </div>

                    <p>
                        {emaIndicator?.reason ??
                            'EMA relationship unavailable.'}
                    </p>
                </article>

                <article
                    className={`technical-card ${stochasticClass}`}
                >
                    <div className="technical-card-heading">
                        <span>STOCHASTIC</span>
                        <i />
                    </div>

                    <div className="technical-main-value">
                        <strong>
                            {stochastic.toFixed(2)}
                        </strong>

                        <span>
                            {stochasticZone}
                        </span>
                    </div>

                    <div className="stochastic-scale">
                        <div className="stochastic-zones">
                            <span>OVERSOLD</span>
                            <span>NEUTRAL</span>
                            <span>OVERBOUGHT</span>
                        </div>

                        <div className="stochastic-track">
                            <i
                                style={{
                                    left: `${Math.min(
                                        Math.max(
                                            stochastic,
                                            0,
                                        ),
                                        100,
                                    )}%`,
                                }}
                            />
                        </div>

                        <div className="stochastic-values">
                            <span>0</span>
                            <span>20</span>
                            <span>50</span>
                            <span>80</span>
                            <span>100</span>
                        </div>
                    </div>

                    <div className="technical-reason">
                        <span>SIGNAL</span>

                        <strong
                            className={
                                stochasticIndicator?.signal.toLowerCase()
                            }
                        >
                            {stochasticIndicator?.signal ??
                                'NEUTRAL'}
                        </strong>
                    </div>

                    <p>
                        {stochasticIndicator?.reason ??
                            'Stochastic analysis unavailable.'}
                    </p>
                </article>
            </div>

            <div className="technical-footer">
                <div className="technical-footer-label">
                    <span>ANALYTICAL ENGINE</span>
                    <strong>2 / 2 INDICATORS ACTIVE</strong>
                </div>

                <div className="technical-indicator-list">
                    {indicators.map((indicator) => (
                        <div
                            key={indicator.name}
                            className="technical-indicator-row"
                        >
                            <span>{indicator.name}</span>

                            <div>
                                <i
                                    className={indicator.signal.toLowerCase()}
                                />

                                <strong
                                    className={indicator.signal.toLowerCase()}
                                >
                                    {indicator.signal}
                                </strong>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
