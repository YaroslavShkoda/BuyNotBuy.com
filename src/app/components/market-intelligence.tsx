interface MarketIntelligenceProps {
    signal: 'LONG' | 'SHORT' | 'NEUTRAL';
    confidence: number;
}

export default function MarketIntelligence({
    signal,
    confidence,
}: MarketIntelligenceProps) {
    const signalClass = signal.toLowerCase();

    return (
        <section className="market-intelligence" id="market-news">
            <div className="intelligence-header">
                <div>
                    <strong>MARKET INTELLIGENCE</strong>
                </div>

                <span>NEWS &amp; MARKET CONTEXT</span>
            </div>

            <div className="intelligence-grid">
                <article className="intelligence-feature">
                    <div className="intelligence-feature-top">
                        <span className="intelligence-status">
                            <i />
                            FEED INITIALIZING
                        </span>

                        <span className="intelligence-index">
                            01
                        </span>
                    </div>

                    <div className="intelligence-feature-content">
                        <span className="intelligence-kicker">
                            MARKET NEWS
                        </span>

                        <h3>
                            Real-time market intelligence
                            is coming soon.
                        </h3>

                        <p>
                            BuyNotBuy will combine market data,
                            technical signals and external news
                            to build a broader view of Bitcoin
                            market conditions.
                        </p>
                    </div>

                    <div className="intelligence-feature-footer">
                        <span>NEWS ENGINE</span>
                        <strong>AWAITING DATA</strong>
                    </div>
                </article>

                <div className="intelligence-side">
                    <article className="intelligence-item">
                        <div className="intelligence-item-top">
                            <span>MARKET CONTEXT</span>
                            <span>02</span>
                        </div>

                        <div className="intelligence-item-body">
                            <div className="intelligence-icon">
                                +
                            </div>

                            <div>
                                <strong>
                                    News aggregation
                                </strong>

                                <p>
                                    External market sources
                                    will appear here.
                                </p>
                            </div>
                        </div>

                        <div className="intelligence-item-meta">
                            <span>STATUS</span>
                            <strong>STANDBY</strong>
                        </div>
                    </article>

                    <article className="intelligence-item">
                        <div className="intelligence-item-top">
                            <span>SENTIMENT</span>
                            <span>03</span>
                        </div>

                        <div className="intelligence-item-body">
                            <div
                                className={`intelligence-sentiment ${signalClass}`}
                            >
                                {signal}
                            </div>

                            <div>
                                <strong>
                                    Current signal context
                                </strong>

                                <p>
                                    Technical engine confidence:
                                    {' '}
                                    {confidence}%
                                </p>
                            </div>
                        </div>

                        <div className="intelligence-item-meta">
                            <span>ANALYTICAL STATE</span>
                            <strong>
                                {signal === 'NEUTRAL'
                                    ? 'BALANCED'
                                    : 'ACTIVE'}
                            </strong>
                        </div>
                    </article>

                    <article className="intelligence-item">
                        <div className="intelligence-item-top">
                            <span>UPCOMING</span>
                            <span>04</span>
                        </div>

                        <div className="intelligence-item-body">
                            <div className="intelligence-icon">
                                +
                            </div>

                            <div>
                                <strong>
                                    News sentiment engine
                                </strong>

                                <p>
                                    Headlines will be classified
                                    by market sentiment.
                                </p>
                            </div>
                        </div>

                        <div className="intelligence-item-meta">
                            <span>PIPELINE</span>
                            <strong>PLANNED</strong>
                        </div>
                    </article>
                </div>
            </div>
        </section>
    );
}
