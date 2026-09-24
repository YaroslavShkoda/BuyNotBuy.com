import type { Candle, MarketAnalysis } from '../types/analysis';

interface MarketDetailsProps {
    candles: Candle[];
    analysis: MarketAnalysis;
}

function compactNumber(value: number) {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function price(value: number) {
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function MarketDetails({ candles, analysis }: MarketDetailsProps) {
    const recent = candles.slice(-5).reverse();
    const aboveEma = analysis.price >= analysis.indicators.ema300;
    const stochasticValue = analysis.indicators.stochastic;
    const stochasticMood = stochasticValue >= 80
        ? 'Зона перекупленности'
        : stochasticValue <= 15
            ? 'Зона перепроданности'
            : 'Нейтральный диапазон';

    const momentum = analysis.momentum.current;
    const momentumSignal = analysis.signal.indicators.find(
        (indicator) => indicator.name === 'Momentum 100',
    )!;
    const divergence = analysis.divergence.bullish
        ? 'BULLISH DIVERGENCE'
        : analysis.divergence.bearish
            ? 'BEARISH DIVERGENCE'
            : 'NO DIVERGENCE';
    const divergenceClass = analysis.divergence.bullish
        ? 'reading-positive'
        : analysis.divergence.bearish
            ? 'reading-negative'
            : 'reading-neutral';

    return (
        <>
            <section className="detail-grid" aria-label="Аналитика рынка">
                <article className="detail-card depth-surface">
                    <header className="detail-heading">
                        <div><span className="eyebrow">ТЕХНИЧЕСКИЙ СРЕЗ</span><h2>Индикаторы</h2></div>
                        <span className="detail-index">01 / 03</span>
                    </header>
                    <div className="indicator-list">
                        <div className="indicator-row">
                            <div><span>EMA 300</span><small>Долгосрочный тренд</small></div>
                            <div className="indicator-reading"><strong>${price(analysis.indicators.ema300)}</strong><span className={aboveEma ? 'reading-positive' : 'reading-negative'}>{aboveEma ? 'Цена выше EMA' : 'Цена ниже EMA'}</span></div>
                        </div>
                        <div className="indicator-row">
                            <div><span>Stochastic</span><small>Импульс цены</small></div>
                            <div className="indicator-reading"><strong>{analysis.indicators.stochastic.toFixed(2)}</strong><span>{stochasticMood}</span></div>
                        </div>
                        <div className="indicator-row">
                            <div><span>Momentum 100</span><small>{momentumSignal.reason}</small></div>
                            <div className="indicator-reading">
                                <strong>{`${momentum > 0 ? '+' : ''}${momentum.toFixed(2)}`}</strong>
                                <span className={`reading-${momentumSignal.signal.toLowerCase()}`}>{momentumSignal.signal}</span>
                                <span className={divergenceClass}>{divergence}</span>
                            </div>
                        </div>
                    </div>
                    <div className="signal-list-heading"><span>СОГЛАСИЕ СИГНАЛОВ</span><span>{analysis.signal.indicators.length} ИНДИКАТОРА</span></div>
                    <div className="detail-signals">
                        {analysis.signal.indicators.map((indicator) => (
                            <div className="detail-signal" key={indicator.name}>
                                <span className="signal-dot" data-tone={indicator.signal.toLowerCase()} />
                                <div><strong>{indicator.name}</strong><small>{indicator.reason}</small></div>
                                <b className={`reading-${indicator.signal.toLowerCase()}`}>{indicator.signal}</b>
                            </div>
                        ))}
                    </div>
                </article>

                <article className="detail-card depth-surface">
                    <header className="detail-heading">
                        <div><span className="eyebrow">ПОСЛЕДНИЕ ИНТЕРВАЛЫ</span><h2>Активность рынка</h2></div>
                        <span className="detail-index">02 / 02</span>
                    </header>
                    <div className="candle-table-wrap">
                        <table className="candle-table">
                            <thead><tr><th>ВРЕМЯ</th><th>ЗАКРЫТИЕ</th><th>ДИАПАЗОН</th><th>ОБЪЁМ</th></tr></thead>
                            <tbody>{recent.map((candle) => (
                                <tr key={candle.timestamp}>
                                    <td>{new Date(candle.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</td>
                                    <td className={candle.close >= candle.open ? 'reading-positive' : 'reading-negative'}>${price(candle.close)}</td>
                                    <td>${price(candle.low)} — ${price(candle.high)}</td>
                                    <td>{compactNumber(candle.volume)}</td>
                                </tr>
                            ))}</tbody>
                        </table>
                        {recent.length === 0 && <p className="table-empty">Нет данных по свечам</p>}
                    </div>
                    <div className="activity-note"><span className="activity-note-dot" />Объёмы окрашены по направлению закрытия свечи</div>
                </article>
            </section>
            <footer className="dashboard-footer"><span>BUYNOTBUY <i>·</i> BTC / USDT</span><span>АНАЛИЗ ОБНОВЛЯЕТСЯ ВМЕСТЕ С РЫНОЧНЫМИ ДАННЫМИ</span></footer>
        </>
    );
}
