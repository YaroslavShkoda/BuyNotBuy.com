import { MarketAnalysisSchema } from '../../backend/api/schemas';
import type { CandleInterval } from '../../backend/types/candle-interval';
import type { MarketAnalysis } from '../types/analysis';
import { fetchJson } from './api-error';

export function analysisUrl(
    instrument?: string,
    interval?: CandleInterval,
): string {
    const base = process.env.BACKEND_URL;
    const intervalQuery = interval === undefined
        ? ''
        : `?interval=${encodeURIComponent(interval)}`;

    return instrument === undefined
        ? `${base}/api/analysis${intervalQuery}`
        : `${base}/api/instruments/${encodeURIComponent(instrument)}/analysis${intervalQuery}`;
}

export async function getAnalysis(
    instrument?: string,
    interval?: CandleInterval,
): Promise<MarketAnalysis> {
    return fetchJson(analysisUrl(instrument, interval), MarketAnalysisSchema);
}
