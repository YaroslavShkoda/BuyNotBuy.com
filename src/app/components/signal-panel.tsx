import type { IndicatorAnalysis, IndicatorSignal, SignalResult } from '../types/analysis';

interface IndicatorValue {
    ema300: number;
    stochastic: number;
    momentum: number;
}

interface SignalPanelProps {
    signal: SignalResult;
    indicatorValues: IndicatorValue;
}

export function getConfidenceWidth(confidence: number): string {
    if (!Number.isFinite(confidence)) return '0%';
    const clamped = Math.min(100, Math.max(0, Math.round(confidence)));
    return `${clamped}%`;
}

// Format a single indicator's numeric value, keyed by its display name so the
// value rendered next to each row matches the name the backend emits.
function getIndicatorValueText(name: string, values: IndicatorValue): string | null {
    switch (name) {
        case 'EMA 300':
            return `$${values.ema300.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
        case 'Стохастик':
            return values.stochastic.toFixed(2);
        case 'Momentum 100':
            return `${values.momentum > 0 ? '+' : ''}${values.momentum.toFixed(2)}`;
        default:
            return null;
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

export function SignalPanel({ signal, indicatorValues }: SignalPanelProps) {
    const signalClass = signal.signal.toLowerCase();
    const voteSummary = getVoteSummary(signal.indicators, signal.signal);

    return (
        <aside className={`signal-panel signal-${signalClass}`}>
            <div className="signal-panel-header">
                <span className="eyebrow">MARKET SIGNAL</span>

                <span className="signal-confidence">
                    {signal.confidence}% CONSENSUS
                </span>
            </div>

            <div className="signal-value">
                <span className="signal-status">
                    {signal.signal}
                </span>

                <div
                    className="signal-meter"
                    role="img"
                    aria-label={`Consensus ${signal.confidence} percent`}
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
                                const indicatorValue = getIndicatorValueText(indicator.name, indicatorValues);

                                return (
                                    <div
                                        className="signal-indicator"
                                        key={indicator.name}
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
                        </div>
                    </aside>
    );
}
