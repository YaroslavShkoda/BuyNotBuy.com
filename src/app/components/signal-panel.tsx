import type { IndicatorAnalysis, IndicatorKey, IndicatorSignal, MarketAnalysis, SignalResult } from '../types/analysis';
import { formatMomentumPercent, formatPercent, formatSignedPercent } from '../lib/format-momentum';

type Periods = MarketAnalysis['periods'];

interface IndicatorValue {
    ema300: number;
    stochastic: number;
    momentum: number;
    atr: number;
    rsi: number;
    macdHistogram: number;
}

/**
 * Indicators that are measured and shown but do not vote.
 *
 * ATR, RSI and MACD describe the market rather than taking a side in it, and
 * RSI and MACD largely restate the stochastic and the EMA. Giving them a
 * LONG/SHORT/NEUTRAL badge would dress a measurement up as a second opinion
 * the signal never asked for, so these rows carry a reading and a caption and
 * nothing else — the left rule that marks a vote stays empty on them.
 */
interface ContextIndicator {
    name: string;
    value: string;
    reason: string;
}

export function getContextIndicators(values: IndicatorValue, periods: Periods): ContextIndicator[] {
    return [
        {
            name: `ATR ${periods.atr}`,
            value: formatPercent(values.atr),
            reason: 'Средняя ширина свечи, %',
        },
        {
            name: `RSI ${periods.rsi}`,
            value: values.rsi.toFixed(1),
            reason: 'Перекупленность и перепроданность',
        },
        {
            name: `MACD ${periods.macdFast}/${periods.macdSlow}/${periods.macdSignal}`,
            value: formatSignedPercent(values.macdHistogram),
            reason: 'Гистограмма, %',
        },
    ];
}

interface SignalPanelProps {
    signal: SignalResult;
    indicatorValues: IndicatorValue;
    periods: Periods;
}

export function getConfidenceWidth(confidence: number): string {
    if (!Number.isFinite(confidence)) return '0%';
    const clamped = Math.min(100, Math.max(0, Math.round(confidence)));
    return `${clamped}%`;
}

// Format a single indicator's numeric value, keyed by the stable indicator key
// rather than by the label. Matching on the label meant the row rendered
// nothing the moment a period changed, because "Momentum 100" stopped matching.
export function getIndicatorValueText(key: IndicatorKey, values: IndicatorValue): string | null {
    switch (key) {
        case 'ema':
            return `$${values.ema300.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
        case 'stochastic':
            return values.stochastic.toFixed(2);
        case 'momentum':
            return formatMomentumPercent(values.momentum);
    }
}

function getIndicatorNoun(count: number): string {
    const mod100 = count % 100;
    const mod10 = count % 10;

    if (mod10 === 1 && mod100 !== 11) return 'индикатор';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'индикатора';
    return 'индикаторов';
}

export function getVoteSummary(
    indicators: IndicatorAnalysis[],
    signal: IndicatorSignal,
): string | null {
    if (indicators.length === 0) return null;

    const longCount = indicators.filter((indicator) => indicator.signal === 'LONG').length;
    const shortCount = indicators.filter((indicator) => indicator.signal === 'SHORT').length;
    const total = indicators.length;

    if (signal === 'LONG' || signal === 'SHORT') {
        const support = signal === 'LONG' ? longCount : shortCount;
        const opposing = signal === 'LONG' ? shortCount : longCount;
        const verb = support === 1 ? 'поддерживает' : 'поддерживают';
        const genitiveNoun = total === 1 ? 'индикатора' : 'индикаторов';
        const base = support === total && total > 1
            ? `Все ${total} ${getIndicatorNoun(total)} поддерживают ${signal}`
            : `${support} из ${total} ${genitiveNoun} ${verb} ${signal}`;

        return opposing > 0 ? `${base} · ${opposing} против` : base;
    }

    // For NEUTRAL the backend reason already states the outcome verbatim
    // ("Индикаторы дают противоположные сигналы" / "Ни один индикатор не даёт сигнала"),
    // so a summary line here would repeat the same sentence twice on the page.
    return null;
}

export function SignalPanel({ signal, indicatorValues, periods }: SignalPanelProps) {
    const signalClass = signal.signal.toLowerCase();
    const voteSummary = getVoteSummary(signal.indicators, signal.signal);
    const contextIndicators = getContextIndicators(indicatorValues, periods);

    return (
        <aside className={`signal-panel signal-${signalClass}`}>
            <div className="signal-panel-header">
                <span className="eyebrow">СИГНАЛ РЫНКА</span>

                <span className="signal-confidence">
                    КОНСЕНСУС {signal.confidence}%
                </span>
            </div>

            <div className="signal-value">
                <span className="signal-status">
                    {signal.signal}
                </span>

                <div
                    className="signal-meter"
                    role="img"
                    aria-label={`Консенсус ${signal.confidence} процентов`}
                >
                    <span
                        className="signal-meter-fill"
                        style={{ width: getConfidenceWidth(signal.confidence) }}
                    />
                </div>

                <span className="signal-reason">
                    {signal.reason}
                </span>
            </div>

            {voteSummary !== null && (
                <p className="signal-vote-summary">{voteSummary}</p>
            )}

            <div className="signal-indicators">
                            {signal.indicators.map((indicator) => {
                                const vote = indicator.signal.toLowerCase();
                                const indicatorValue = getIndicatorValueText(indicator.key, indicatorValues);

                                return (
                                    <div
                                        className="signal-indicator"
                                        key={indicator.key}
                                        data-vote={vote}
                                    >
                                        <div className="signal-indicator-top">
                                            <span>{indicator.name}</span>

                                            <div className="signal-indicator-right">
                                                {indicatorValue !== null && (
                                                    <span className="signal-indicator-value">
                                                        {indicatorValue}
                                                    </span>
                                                )}
                                                <strong className={`vote-${vote}`}>{indicator.signal}</strong>
                                            </div>
                                        </div>

                                        <span className="signal-indicator-reason">
                                            {indicator.reason}
                                        </span>
                                    </div>
                                );
                            })}

                            {contextIndicators.map((indicator) => (
                                <div
                                    className="signal-indicator signal-indicator-context"
                                    key={indicator.name}
                                    data-vote="context"
                                >
                                    <div className="signal-indicator-top">
                                        <span>{indicator.name}</span>

                                        <div className="signal-indicator-right">
                                            <span className="signal-indicator-value">
                                                {indicator.value}
                                            </span>
                                        </div>
                                    </div>

                                    <span className="signal-indicator-reason">
                                        {indicator.reason}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </aside>
    );
}
