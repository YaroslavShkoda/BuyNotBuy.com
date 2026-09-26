import type { Candle, DivergenceAnalysis, MarketAnalysis } from '../types/analysis';
import { formatMomentumPercent, formatPercent, formatSignedPercent } from '../lib/format-momentum';
import { quoteAssetOf } from '../lib/quote-asset';

interface MarketDetailsProps {
    candles: Candle[];
    analysis: MarketAnalysis;
    /**
     * Needed to name the currency the volume column is counted in. The analysis
     * payload carries only a price, because nothing else in it has an opinion
     * about which pair is being shown.
     */
    symbol: string;
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
    return formatMomentumPercent(value, 1);
}

/**
 * The noun a numeral takes, in the genitive: "1 свеча", "3 свечи", "7 свечей".
 *
 * A count followed by "назад" is not in the prepositional case. "В 3 свечах" is
 * a place; "3 свечи назад" is a distance back from now, and it wants the same
 * form as any other counted noun. The prepositional endings produced "1 свече
 * назад" and "53 свечах назад", which read as grammar borrowed from the wrong
 * part of the sentence.
 *
 * The teens are the whole difficulty: the last digit picks the form everywhere
 * else and lies in exactly the numbers a count is most likely to land on.
 */
function pluralizeBars(value: number): string {
    const mod100 = Math.abs(value) % 100;
    const mod10 = Math.abs(value) % 10;

    if (mod10 === 1 && mod100 !== 11) return 'свеча';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'свечи';
    return 'свечей';
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
        detail: `Цена: ${formatDivergencePrice(previous.price)} → ${formatDivergencePrice(current.price)} (${priceDirection}) · Momentum: ${formatDivergenceMomentum(previous.momentum)} → ${formatDivergenceMomentum(current.momentum)} (${momentumDirection}) · Подтверждена ${current.age} ${pluralizeBars(current.age)} назад`,
    };
}

export function MarketDetails({ candles, analysis, symbol }: MarketDetailsProps) {
    // The grid stretches both cards to the same height, so the activity table
    // has to carry the difference: the left card is tall because its captions
    // wrap, and this one used to stop after five rows with dead space under it.
    // Sixteen rows fills a desktop column, and the table is given `height: 100%`
    // so any leftover is taken by the rows rather than left as a gap.
    const recent = candles.slice(-16).reverse();
    const aboveEma = analysis.price >= analysis.indicators.ema300;
    const stochasticValue = analysis.indicators.stochastic;
    const stochasticZone = getStochasticZone(stochasticValue);
    const stochasticVote = analysis.signal.indicators.find(
        (indicator) => indicator.key === 'stochastic',
    );
    const momentumVote = analysis.signal.indicators.find(
        (indicator) => indicator.key === 'momentum',
    );
    const emaVote = analysis.signal.indicators.find(
        (indicator) => indicator.key === 'ema',
    );
    const divergence = describeDivergence(analysis.divergence);
    const momentumPeriod = analysis.momentum.period;
    const indicators = analysis.indicators;
    const periods = analysis.periods;
    // The label follows the vote rather than repeating a literal. With the
    // shipped periods both produce the same text, and when the period becomes
    // configurable the heading stops contradicting the number underneath it.
    const emaLabel = emaVote?.name ?? 'EMA';

    return (
        <>
            <section className="detail-grid" aria-label="Аналитика рынка">
                <article className="detail-card depth-surface">
                    <header className="detail-heading">
                        <div><span className="eyebrow">ТЕХНИЧЕСКИЙ СРЕЗ</span><h2>Из чего складывается сигнал</h2></div>
                    </header>

                    <div className="detail-section">
                        <div className="signal-list-heading"><span>ТРЕНД</span><span>{emaLabel}</span></div>
                        <div className="indicator-list">
                            <div className="indicator-row">
                                <div><span>{emaLabel}</span><small>Долгосрочный тренд</small></div>
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
                                <div><span>Momentum {momentumPeriod}</span><small>{`Изменение цены за ${momentumPeriod} периодов, %`}</small></div>
                                <div className="indicator-reading">
                                    <strong>{formatMomentumPercent(analysis.momentum.current)}</strong>
                                    {momentumVote !== undefined && (
                                        <span className={`reading-${momentumVote.signal.toLowerCase()}`}>{momentumVote.signal}</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="detail-section">
                        <div className="signal-list-heading"><span>ВОЛАТИЛЬНОСТЬ И СИЛА</span><span>ATR · RSI · MACD</span></div>
                        <div className="indicator-list">
                            <div className="indicator-row">
                                <div><span>{`ATR ${periods.atr}`}</span><small>Средняя ширина свечи, %</small></div>
                                <div className="indicator-reading">
                                    <strong>{formatPercent(indicators.atr)}</strong>
                                </div>
                            </div>
                            <div className="indicator-row">
                                <div><span>{`RSI ${periods.rsi}`}</span><small>Перекупленность и перепроданность</small></div>
                                <div className="indicator-reading">
                                    <strong>{indicators.rsi.toFixed(1)}</strong>
                                </div>
                            </div>
                            <div className="indicator-row">
                                <div>
                                    <span>{`MACD ${periods.macdFast}/${periods.macdSlow}/${periods.macdSignal}`}</span>
                                    <small>Гистограмма, %</small>
                                </div>
                                <div className="indicator-reading">
                                    <strong>{formatSignedPercent(indicators.macd.histogram / analysis.price, 3)}</strong>
                                    <span className={indicators.macd.histogram >= 0 ? 'reading-positive' : 'reading-negative'}>
                                        {indicators.macd.histogram >= 0 ? 'Быки сильнее' : 'Медведи сильнее'}
                                    </span>
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

                <article className="detail-card detail-card-activity depth-surface">
                    <header className="detail-heading">
                        <div><span className="eyebrow">ПОСЛЕДНИЕ ИНТЕРВАЛЫ</span><h2>Активность рынка</h2></div>
                    </header>
                    <div className="candle-table-wrap">
                        <table className="candle-table">
                            <thead><tr><th>ВРЕМЯ</th><th>ЗАКРЫТИЕ</th><th>ДИАПАЗОН</th><th>ОБЪЁМ, {quoteAssetOf(symbol)}</th></tr></thead>
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
