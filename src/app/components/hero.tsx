import type { CandleInterval } from '../../backend/types/candle-interval';
import { SnapshotStrip } from './snapshot-strip';
import type { MarketInstrument } from '../lib/market';
import type { Candle, MarketAnalysis } from '../types/analysis';
import type { SignalHistoryResponse } from '../types/history';
import { MarketChart } from './market-chart';
import { SignalHistory } from './signal-history';
import { SignalPanel } from './signal-panel';

interface HeroProps {
    analysis: MarketAnalysis;
    history: SignalHistoryResponse | null;
    candles: Candle[];
    symbol: string;
    /** The registry's answer about this market; null when it has none. */
    instrument: MarketInstrument | null;
    ema300: number;
    interval: CandleInterval;
    marketSnapshot?: MarketAnalysis['snapshot'];
}

function AssetMark({ base }: { base: string }) {
    // A generic initial works for every registry asset and does not imply a
    // special case or icon mapping that the registry does not provide.
    return (
        <span className="hero-asset-mark hero-asset-letter" aria-hidden="true">
            {Array.from(base)[0] ?? '?'}
        </span>
    );
}

export function Hero({ analysis, history, candles, symbol, instrument, ema300, interval, marketSnapshot }: HeroProps) {
    const { signal, indicators, price, momentum } = analysis;
    // Name and display form come from the registry, not from a parse of the
    // symbol; when the registry cannot name the market, the raw ticker is the
    // honest fallback and the base the glyph falls back to.
    const name = instrument?.name ?? symbol;
    const base = instrument?.base ?? symbol;
    // The quote currency the price is denominated in. Null means the registry
    // could not name it, and an unlabelled number beats a wrong label.
    const quote = instrument?.quote ?? null;

    return (
            <section className="hero depth-surface">
                <div className="hero-main">
                    <div className="hero-heading">
                        <span className="eyebrow">ОБЗОР РЫНКА</span>

                        {/* The badge, the name and the price read as one figure:
                            the name, and the number for it, stacked on a shared
                            left edge beside the badge. */}
                        <div className="hero-asset-line">
                            <span className="hero-asset-glyph" aria-hidden="true">
                                <AssetMark base={base} />
                            </span>

                            <div className="hero-asset-text">
                                <h1>{name}</h1>

                                <div className="hero-price-block">
                                    <span className="hero-price">
                                        {price.toLocaleString('en-US', {
                                            minimumFractionDigits: 2,
                                            maximumFractionDigits: 2,
                                        })}
                                        {quote !== null ? ` ${quote}` : ''}
                                    </span>

                                    <span className="hero-price-label">
                                        {instrument?.displaySymbol ?? symbol}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <SnapshotStrip label="График" snapshot={marketSnapshot} />
                    {/* The market chart lives directly under the asset block in the
                        left column of the unified hero panel. */}
                    <div className="hero-chart">
                        <MarketChart
                            candles={candles}
                            symbol={symbol}
                            quote={instrument?.quote ?? null}
                            ema300={ema300}
                            interval={interval}
                        />
                    </div>
                </div>

                <div className="hero-side">
                    <SnapshotStrip label="Анализ" snapshot={analysis.snapshot} />
                    <SignalPanel
                        signal={signal}
                        periods={analysis.periods}
                        quote={quote}
                        indicatorValues={{
                            ema300: indicators.ema300,
                            stochastic: indicators.stochastic,
                            momentum: momentum.current,
                            atr: indicators.atr,
                            rsi: indicators.rsi,
                            macdHistogram: indicators.macd.histogram,
                            price,
                        }}
                    />
                    <SignalHistory data={history} />
                </div>
            </section>
        );
}
