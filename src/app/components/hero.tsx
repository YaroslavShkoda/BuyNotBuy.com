import type { Candle, MarketAnalysis } from '../types/analysis';
import type { SignalHistoryResponse } from '../types/history';
import { SignalPanel } from './signal-panel';
import { SignalHistory } from './signal-history';
import { MarketChart } from './market-chart';
import { getAssetInfo } from '../lib/assets';

interface HeroProps {
    analysis: MarketAnalysis;
    history: SignalHistoryResponse | null;
    candles: Candle[];
    symbol: string;
    ema300: number;
}

export function Hero({ analysis, history, candles, symbol, ema300 }: HeroProps) {
    const { signal, indicators, price, momentum } = analysis;
    const asset = getAssetInfo(symbol);

    return (
            <section className="hero depth-surface">
                <div className="hero-main">
                    <div className="hero-heading">
                        <div className="hero-title">
                            <span className="eyebrow">MARKET OVERVIEW</span>

                            <div className="hero-asset-line">
                                <span className="hero-asset-glyph" aria-hidden="true">
                                    {asset.glyph}
                                </span>

                                <div>
                                    <h1>{asset.name}</h1>

                                    <p className="hero-description">
                                        Real-time market structure and technical intelligence.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="hero-price-block">
                            <span className="hero-price">
                                ${price.toLocaleString('en-US', {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                })}
                            </span>

                            <span className="hero-price-label">
                                {asset.ticker} / {asset.quote}
                            </span>
                        </div>
                    </div>

                    {/* The market chart lives directly under the asset block in the
                        left column of the unified hero panel. */}
                    <div className="hero-chart">
                        <MarketChart candles={candles} symbol={symbol} ema300={ema300} />
                    </div>
                </div>

                <div className="hero-side">
                    <SignalPanel
                        signal={signal}
                        indicatorValues={{
                            ema300: indicators.ema300,
                            stochastic: indicators.stochastic,
                            momentum: momentum.current,
                        }}
                    />
                    <SignalHistory data={history} />
                </div>
            </section>
        );
}
