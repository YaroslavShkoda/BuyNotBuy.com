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

// The asset badge used to render the "₿" character straight from the map. That
// glyph lives in U+20BF, which plenty of system fonts simply do not ship (a
// missing codepoint renders as a tofu box), and font-weight: 700 is often
// synthesised by smearing, which looks soft at badge size. A path stays sharp
// at any resolution and inherits the accent colour from the tile.
function BitcoinMark() {
    return (
        <svg
            className="hero-asset-mark"
            viewBox="0 0 48 48"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {/* Two bowls, the shared stem, and the four tick marks above/below. */}
            <path d="M15 10h10a7 7 0 0 1 0 14H15M15 24h11a7 7 0 0 1 0 14H15M15 10v28" />
            <path d="M21 10V4M29 10V4M21 38v6M29 38v6" />
        </svg>
    );
}

export function Hero({ analysis, history, candles, symbol, ema300 }: HeroProps) {
    const { signal, indicators, price, momentum } = analysis;
    const asset = getAssetInfo(symbol);

    return (
            <section className="hero depth-surface">
                <div className="hero-main">
                    <div className="hero-heading">
                        <span className="eyebrow">ОБЗОР РЫНКА</span>

                        {/* The badge, the asset name and the price share one
                            centred row, so the price starts level with the name
                            instead of being pushed down by an offset invented
                            to clear the eyebrow. */}
                        <div className="hero-heading-row">
                            <div className="hero-asset-line">
                                <span className="hero-asset-glyph" aria-hidden="true">
                                    {asset.glyph === '₿' ? <BitcoinMark /> : asset.glyph}
                                </span>

                                <h1>{asset.name}</h1>
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
                        periods={analysis.periods}
                        indicatorValues={{
                            ema300: indicators.ema300,
                            stochastic: indicators.stochastic,
                            momentum: momentum.current,
                            atr: indicators.atr,
                            rsi: indicators.rsi,
                            macdHistogram: indicators.macd.histogram,
                        }}
                    />
                    <SignalHistory data={history} />
                </div>
            </section>
        );
}
