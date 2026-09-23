import type { SignalResult } from '../types/analysis';

interface SignalPanelProps {
    signal: SignalResult;
}

export function SignalPanel({ signal }: SignalPanelProps) {
    const signalClass = signal.signal.toLowerCase();

    return (
        <aside className={`signal-panel depth-surface signal-${signalClass}`}>
            <div className="signal-panel-header">
                <span className="eyebrow">MARKET SIGNAL</span>

                <span className="signal-confidence">
                    {signal.confidence}% CONFIDENCE
                </span>
            </div>

            <div className="signal-value">
                <span className="signal-status">
                    {signal.signal}
                </span>

                <span className="signal-reason">
                    {signal.reason}
                </span>
            </div>

            <div className="signal-indicators">
                {signal.indicators.map((indicator) => (
                    <div
                        className="signal-indicator"
                        key={indicator.name}
                    >
                        <div className="signal-indicator-top">
                            <span>{indicator.name}</span>
                            <strong>{indicator.signal}</strong>
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
