import Link from 'next/link';

import {
    type CandleInterval,
    SUPPORTED_CANDLE_INTERVALS,
} from '../../backend/types/candle-interval';
import { intervalHref, intervalLabel } from '../lib/interval';

interface IntervalSwitcherProps {
    symbol: string;
    interval: CandleInterval;
}

export function IntervalSwitcher({ symbol, interval }: IntervalSwitcherProps) {
    return (
        <nav className="interval-switcher" aria-label="Таймфрейм графика">
            {SUPPORTED_CANDLE_INTERVALS.map((value) => (
                <Link
                    key={value}
                    href={intervalHref(symbol, value)}
                    className={
                        value === interval
                            ? 'interval-option is-active'
                            : 'interval-option'
                    }
                    aria-current={value === interval ? 'page' : undefined}
                >
                    {intervalLabel(value)}
                </Link>
            ))}
        </nav>
    );
}
