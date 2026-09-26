import type { Candle, DivergenceAnalysis, MarketAnalysis } from '../types/analysis';

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

export function getStochasticZone(value: number): string {
    return value >= 80
        ? 'Зона перекупленности'
        : value <= 15
            ? 'Зона перепроданности'
            : 'Нейтральный диапазон';
}

export interface DivergencePresentation {
    label: string;
    tone: 'positive' | 'negative' | 'neutral';
    detail: string | null;
}

function formatDivergencePrice(value: number): string {
    return `$${Math.round(value).toLocaleString('en-US')}`;
}

function formatDivergenceMomentum(value: number): string {
    return `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
}

export function describeDivergence(divergence: DivergenceAnalysis): DivergencePresentation {
    const found = divergence.bullish ?? divergence.bearish;

    if (found === null) {
        return {
            label: 'Дивергенция не обнаружена',
            tone: 'neutral',
            detail: null,
        };
    }

    const isBullish = divergence.bullish !== null;
    const { previous, current } = found;
    const priceDirection = current.price < previous.price
        ? 'ниже'
        : current.price > previous.price
            ? 'выше'
            : 'на том же уровне';
    const momentumDirection = current.momentum < previous.momentum
        ? 'ниже'
        : current.momentum > previous.momentum
            ? 'выше'
            : 'на том же уровне';

    return {
        label: isBullish ? 'Бычья дивергенция' : 'Медвежья дивергенция',
        tone: isBullish ? 'positive' : 'negative',
        detail: `Цена: ${formatDivergencePrice(previous.price)} → ${formatDivergencePrice(current.price)} (${priceDirection}) · Momentum: ${formatDivergenceMomentum(previous.momentum)} → ${formatDivergenceMomentum(current.momentum)} (${momentumDirection})`,
    };
}

export function MarketDetails({ candles, analysis }: MarketDetailsProps) {
    const recent = candles.slice(-5).reverse();
    const aboveEma = analysis.price >= analysis.indicators.ema300;
    const stochasticValue = analysis.indicators.stochastic;
    const stochasticZone = getStochasticZone(stochasticValue);
    const stochasticVote = analysis.signal.indicators.find(
        (indicator) => indicator.name === 'Стохастик',
    );
    const momentumVote = analysis.signal.indicators.find(
        (indicator) => indicator.name.startsWith('Momentum'),
    );
    const divergence = describeDivergence(analysis.divergence);
    const momentumPeriod = analysis.momentum.period;

    return (
        <>
            <section className="detail-grid" aria-label="Аналитика рынка">
                <article className="detail-card depth-surface">
                    <header className="detail-heading">
                        <div><span className="eyebrow">ТЕХНИЧЕСКИЙ СРЕЗ</span><h2>Из чего складывается сигнал</h2></div>
                    </header>

                    <div className="detail-section">
                        <div className="signal-list-heading"><span>ТРЕНД</span><span>EMA 300</span></div>
                        <div className="indicator-list">
                            <div className="indicator-row">
                                <div><span>EMA 300</span><small>Долгосрочный тренд</small></div>
                                <div className="indicator-reading"><strong>${price(analysis.indicators.ema300)}</strong><span className={aboveEma ? 'reading-positive' : 'reading-negative'}>{aboveEma ? 'Цена выше EMA' : 'Цена ниже EMA'}</span></div>
                            </div>
                        </div>
                    </div>

                    <div className="detail-section">
                        <div className="signal-list-heading"><span>ИМПУЛЬС</span><span>STOCHASTIC · MOMENTUM</span></div>
                        <div className="indicator-list">
                            <div className="indicator-row">
                                <div><span>Stochastic</span><small>{stochasticZone}</small></div>
                                <div className="indicator-reading">
                                    <strong>{stochasticValue.toFixed(2)}</strong>
                                    {stochasticVote !== undefined && (
                                        <span className={`reading-${stochasticVote.signal.toLowerCase()}`}>{stochasticVote.signal}</span>
                                    )}
                                </div>
                            </div>
                            <div className="indicator-row">
                                <div><span>Momentum {momentumPeriod}</span><small>{`Изменение цены за ${momentumPeriod} периодов`}</small></div>
                                <div className="indicator-reading">
                                    <strong>{`${analysis.momentum.current > 0 ? '+' : ''}${analysis.momentum.current.toFixed(2)}`}</strong>
                                    {momentumVote !== undefined && (
                                        <span className={`reading-${momentumVote.signal.toLowerCase()}`}>{momentumVote.signal}</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="detail-section">
                        <div className="signal-list-heading"><span>ДИВЕРГЕНЦИЯ</span><span>ЦЕНА VS MOMENTUM</span></div>
                        <div className="divergence-block">
                            <b className={`reading-${divergence.tone}`}>{divergence.label}</b>
                            {divergence.detail !== null && <p>{divergence.detail}</p>}
                        </div>
                    </div>
                </article>

                <article className="detail-card depth-surface">
                    <header className="detail-heading">
                        <div><span className="eyebrow">ПОСЛЕДНИЕ ИНТЕРВАЛЫ</span><h2>Активность рынка</h2></div>
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
                </article>
            </section>
            <footer className="dashboard-footer"><span>BUYNOTBUY <i>·</i> BTC / USDT</span><span>АНАЛИЗ ОБНОВЛЯЕТСЯ ВМЕСТЕ С РЫНОЧНЫМИ ДАННЫМИ</span></footer>
        </>
    );
}
