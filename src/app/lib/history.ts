import type { SignalHistoryResponse } from '../types/history';
import { fetchJson } from './api-error';

// One entry per hour: 24 entries cover the last 24 hours.
const SIGNAL_HISTORY_LIMIT = 24;

export async function getSignalHistory(): Promise<SignalHistoryResponse> {
    return fetchJson<SignalHistoryResponse>(
        `${process.env.BACKEND_URL}/api/signal-history?limit=${SIGNAL_HISTORY_LIMIT}`,
    );
}
