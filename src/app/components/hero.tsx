import type { MarketAnalysis } from '../types/analysis';
import { SignalPanel } from './signal-panel';

interface HeroProps {
    analysis: MarketAnalysis;
}

export function Hero({ analysis }: HeroProps) {
    const { signal, indicators, price } = analysis;

    return (
        <section className="hero">
            <div className="hero-main depth-surface">
                <div className="hero-heading">
                    <div>
                        <span className="eyebrow">MARKET OVERVIEW</span>

                        <h1>Bitcoin</h1>

                        <p className="hero-description">
                            Real-time market structure and technical intelligence.
                        </p>
                    </div>

                    <div className="hero-price-block">
                        <span className="hero-price">
                            ${price.toLocaleString('en-US', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                            })}
                        </span>

                        <span className="hero-price-label">
                            BTC / USDT
                        </span>
                    </div>
                </div>

                <div className="hero-metrics">
                    <div className="hero-metric">
                        <span>EMA 300</span>
                        <strong>
                            ${indicators.ema300.toLocaleString('en-US', {
                                maximumFractionDigits: 2,
                            })}
                        </strong>
                    </div>

                    <div className="hero-metric">
                        <span>STOCHASTIC</span>
                        <strong>
                            {indicators.stochastic.toFixed(2)}
                        </strong>
                    </div>

                    <div className="hero-metric">
                        <span>CONFIDENCE</span>
                        <strong>{signal.confidence}%</strong>
                    </div>
                </div>
            </div>

            <SignalPanel signal={signal} />
        </section>
    );
}
