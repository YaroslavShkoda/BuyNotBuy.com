import Link from 'next/link';

import {
    type CandleInterval,
    SUPPORTED_CANDLE_INTERVALS,
} from '../../backend/types/candle-interval';
import { intervalHref, intervalLabel } from '../lib/interval';

export interface IntervalLinkOption {
    value: CandleInterval;
    href: string;
    label: string;
    active: boolean;
    /**
     * Switching a timeframe must leave the page where the reader has it. Next
     * Link scrolls to the top when the target Page is out of view, so every
     * link opts out of that.
     */
    scroll: false;
}

/**
 * Builds the timeframe links for one market's chart.
 *
 * Kept out of the component so the scroll contract is testable without a DOM.
 */
export function intervalLinks(
    symbol: string,
    interval: CandleInterval,
): readonly IntervalLinkOption[] {
    return SUPPORTED_CANDLE_INTERVALS.map((value) => ({
        value,
        href: intervalHref(symbol, value),
        label: intervalLabel(value),
        active: value === interval,
        scroll: false,
    }));
}

interface IntervalSwitcherProps {
    symbol: string;
    interval: CandleInterval;
}

export function IntervalSwitcher({ symbol, interval }: IntervalSwitcherProps) {
    return (
        <nav className="interval-switcher" aria-label="Таймфрейм графика">
            {intervalLinks(symbol, interval).map((option) => (
                <Link
                    key={option.value}
                    href={option.href}
                    scroll={option.scroll}
                    className={option.active ? 'interval-option is-active' : 'interval-option'}
                    aria-current={option.active ? 'page' : undefined}
                >
                    {option.label}
                </Link>
            ))}
        </nav>
    );
}
