import { getAnalysis } from './lib/analysis';
import { getMarket } from './lib/market';
import MarketChart from './components/market-chart';
import MarketPulse from './components/market-pulse';
import MarketActivity from './components/market-activity';
import TechnicalAnalysis from './components/technical-analysis';
import MarketIntelligence from './components/market-intelligence';

export default async function Home() {
    const [analysis, market] = await Promise.all([
        getAnalysis(),
        getMarket(),
    ]);

    const signal = analysis.signal.signal;
    const confidence = analysis.signal.confidence;
    const signalClass = signal.toLowerCase();

    const emaIndicator = analysis.signal.indicators.find(
        (indicator) => indicator.name.toLowerCase().includes('ema')
    );

    const stochasticIndicator = analysis.signal.indicators.find(
        (indicator) =>
            /stoch|стох/i.test(indicator.name)
    );

    const formattedPrice = analysis.price.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });

    const updatedAt = new Date(analysis.timestamp).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });

    return (
        <main>
            <header className="topbar">
                <div className="brand">
                    <div className="logo-wrap">
                        <img
                            src="/BuyNotBuy.png"
                            alt="BuyNotBuy"
                            className="logo"
                        />
                    </div>

                    <div className="brand-copy">
                        <h1>BuyNotBuy</h1>
                        <p>BITCOIN INTELLIGENCE TERMINAL</p>
                    </div>
                </div>

                <nav className="main-nav" aria-label="Main navigation">
                    <a className="nav-item active" href="#market">MARKET</a>
                    <a className="nav-item" href="#market-analysis">ANALYSIS</a>
                    <a className="nav-item" href="#market-news">NEWS</a>
                    <a className="nav-item" href="#about">ABOUT</a>
                </nav>

                <div className="topbar-market">
                    <div className="live-status">
                        <span className="live-dot" />
                        <div>
                            <strong>LIVE</strong>
                            <small>MARKET DATA</small>
                        </div>
                    </div>

                    <div className="pair">
                        <strong>BTC / USDT</strong>
                        <small>SPOT</small>
                    </div>

                    <button className="settings-button" type="button">SETTINGS</button>
                </div>
            </header>

            <section className="hero" id="market">
                <div className="price-panel">
                    <div className="hero-top">
                        <div className="pair-label">
                            <strong>BTC / USDT</strong>
                            <span>SPOT</span>
                        </div>

                        <div className="provider">
                            <span className="live-pill">
                                <i />
                                LIVE
                            </span>

                            <strong>MARKET DATA</strong>
                        </div>
                    </div>

                    <div className="price">
                        <span>$</span>
                        <strong>{formattedPrice}</strong>
                    </div>

                    <div className="price-subtitle">
                        <span>BITCOIN</span>
                        <span>LIVE MARKET DATA</span>
                    </div>

                    <MarketChart
                        candles={market.candles}
                        ema={analysis.indicators.ema300}
                    />

                    <div className="last-update">
                        <span>LAST UPDATE</span>
                        <strong>{updatedAt}</strong>
                    </div>
                </div>

                <div className={`signal-panel ${signalClass}`}>
                    <div className="panel-heading">
                        <span>MARKET SIGNAL</span>
                    </div>

                    <div className="signal-content">
                        <div
                            className="confidence-ring"
                            style={
                                {
                                    '--confidence-angle': `${confidence * 3.6}deg`,
                                } as React.CSSProperties
                            }
                        >
                            <div className="confidence-inner">
                                <strong>{confidence}%</strong>
                                <span>CONFIDENCE</span>
                            </div>
                        </div>

                        <div className="signal-copy">
                            <span>CURRENT DIRECTION</span>
                            <strong>{signal}</strong>
                            <p>{analysis.signal.reason}</p>
                        </div>
                    </div>
                </div>
            </section>

            <section className="market-stats">
                <div>
                    <span>ASSET</span>
                    <strong>BTC</strong>
                </div>

                <div>
                    <span>QUOTE</span>
                    <strong>USDT</strong>
                </div>

                <div>
                    <span>TIMEFRAME</span>
                    <strong>1H</strong>
                </div>

                <div>
                    <span>ANALYSIS ENGINE</span>
                    <strong className="status-value">
                        <i />
                        ACTIVE
                    </strong>
                </div>

                <div>
                    <span>DATA PROVIDER</span>
                    <strong className="status-value">
                        <i />
                        CONNECTED
                    </strong>
                </div>
            </section>

            <MarketPulse
                price={analysis.price}
                ema={analysis.indicators.ema300}
                stochastic={analysis.indicators.stochastic}
                signal={signal}
                confidence={confidence}
                emaSignal={emaIndicator?.signal}
                stochasticSignal={stochasticIndicator?.signal}
            />
            <MarketActivity
                candles={market.candles}
            />
            <TechnicalAnalysis
                ema={analysis.indicators.ema300}
                stochastic={analysis.indicators.stochastic}
                price={analysis.price}
                indicators={analysis.signal.indicators}
            />
            <MarketIntelligence
                signal={signal}
                confidence={confidence}
            />
            <section className="lower-grid">
                <article className="breakdown-card">
                    <div className="section-title">
                        <div>
                            <strong>SIGNAL BREAKDOWN</strong>
                        </div>
                    </div>

                    <div className="breakdown-list">
                        {analysis.signal.indicators.map(
                            (indicator, index) => (
                                <div
                                    className="breakdown-row"
                                    key={indicator.name}
                                >
                                    <span className="row-number">
                                        0{index + 1}
                                    </span>

                                    <div className="row-name">
                                        <strong>{indicator.name}</strong>
                                        <span>{indicator.reason}</span>
                                    </div>

                                    <div className="row-progress">
                                        <div
                                            style={{
                                                width: `${analysis.signal.confidence}%`,
                                            }}
                                        />
                                    </div>

                                    <div className="row-result">
                                        <span
                                            className={indicator.signal.toLowerCase()}
                                        >
                                            {indicator.signal}
                                        </span>

                                        <strong>100%</strong>
                                    </div>
                                </div>
                            )
                        )}
                    </div>
                </article>

                <article className="system-card">
                    <div className="section-title">
                        <div>
                            <strong>SYSTEM STATUS</strong>
                        </div>
                    </div>

                    <div className="system-list">
                        <div>
                            <span>
                                <i />
                                Market data
                            </span>
                            <strong>CONNECTED</strong>
                        </div>

                        <div>
                            <span>
                                <i />
                                Analysis engine
                            </span>
                            <strong>ACTIVE</strong>
                        </div>

                        <div>
                            <span>
                                <i />
                                Signal engine
                            </span>
                            <strong>ACTIVE</strong>
                        </div>

                        <div>
                            <span>
                                <i />
                                News engine
                            </span>
                            <strong>SOON</strong>
                        </div>
                    </div>
                </article>

                <article className="news-card">
                    <div className="section-title">
                        <div>
                            <strong>MARKET NEWS</strong>
                        </div>

                        <button className="section-action" type="button">ALL NEWS</button>
                    </div>

                    <div className="news-content">
                        <div className="news-icon">+</div>

                        <div>
                            <span>NEWS INTEGRATION</span>
                            <strong>COMING SOON</strong>
                            <p>
                                Stay tuned for the latest market news,
                                analysis and insights.
                            </p>
                        </div>
                    </div>
                </article>
            </section>

            <footer id="about">
                <strong>BuyNotBuy</strong>
                <span>MARKET INTELLIGENCE / 2026</span>
                <span>Bitcoin Intelligence Terminal</span>

                <div>
                    DATA / ANALYSIS / INSIGHTS / AHEAD OF THE MARKET
                </div>
            </footer>
        </main>
    );
}
