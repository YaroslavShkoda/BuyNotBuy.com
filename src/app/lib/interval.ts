import {
    type CandleInterval,
    SUPPORTED_CANDLE_INTERVALS,
} from '../../backend/types/candle-interval';
import { BackendApiError } from './api-error';

export const DEFAULT_INTERVAL: CandleInterval = '1h';

export const INTERVAL_LABELS: Record<CandleInterval, string> = {
    '15m': '15м',
    '1h': '1ч',
    '4h': '4ч',
    '1d': '1д',
};

export const CANDLE_STEP_LABELS: Record<CandleInterval, string> = {
    '15m': '15 минут',
    '1h': 'час',
    '4h': '4 часа',
    '1d': 'сутки',
};

function isCandleInterval(value: unknown): value is CandleInterval {
    return typeof value === 'string'
        && (SUPPORTED_CANDLE_INTERVALS as readonly string[]).includes(value);
}

export function normalizeInterval(value: unknown): CandleInterval {
    const raw = Array.isArray(value) ? value[0] : value;

    return isCandleInterval(raw) ? raw : DEFAULT_INTERVAL;
}

export function intervalLabel(interval: CandleInterval): string {
    return INTERVAL_LABELS[interval];
}

export function candleStepLabel(interval: CandleInterval): string {
    return CANDLE_STEP_LABELS[interval];
}

export function intervalHref(
    symbol: string,
    interval: CandleInterval = DEFAULT_INTERVAL,
): string {
    return `/market/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}`;
}

export function isInsufficientHistoryError(error: unknown): boolean {
    return error instanceof BackendApiError
        && error.status === 503
        && error.code === 'MARKET_INSUFFICIENT_HISTORY';
}

const MARKET_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
    'MARKET_DATA_UNAVAILABLE',
    'MARKET_PROVIDER_ERROR',
    'MARKET_PROVIDER_TIMEOUT',
    'MARKET_RATE_LIMITED',
    'RATE_LIMITED',
]);

const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export function isMarketUnavailableError(error: unknown): boolean {
    if (error instanceof BackendApiError) {
        return UNAVAILABLE_STATUSES.has(error.status)
            && MARKET_UNAVAILABLE_CODES.has(error.code);
    }

    return error instanceof TypeError;
}
