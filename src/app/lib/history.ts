import { SignalHistoryResponseSchema } from '../../backend/api/schemas';
import type { CandleInterval } from '../../backend/types/candle-interval';
import type { SignalHistoryResponse } from '../types/history';
import { fetchJson } from './api-error';

// One entry per hour: 24 entries cover the last 24 hours.
const SIGNAL_HISTORY_LIMIT = 24;

export function signalHistoryUrl(
    instrument?: string,
    interval?: CandleInterval,
): string {
    const instrumentQuery = instrument === undefined
        ? ''
        : `&instrument=${encodeURIComponent(instrument)}`;
    const intervalQuery = interval === undefined
        ? ''
        : `&interval=${encodeURIComponent(interval)}`;

    return `${process.env.BACKEND_URL}/api/signal-history?limit=${SIGNAL_HISTORY_LIMIT}${instrumentQuery}${intervalQuery}`;
}

export async function getSignalHistory(
    instrument?: string,
    interval?: CandleInterval,
): Promise<SignalHistoryResponse> {
    return fetchJson(signalHistoryUrl(instrument, interval), SignalHistoryResponseSchema);
}
