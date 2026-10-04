import type { MarketAnalysis } from '../types/analysis';
import { fetchJson } from './api-error';

export function analysisUrl(instrument?: string): string {
    const base = process.env.BACKEND_URL;

    return instrument === undefined
        ? `${base}/api/analysis`
        : `${base}/api/instruments/${encodeURIComponent(instrument)}/analysis`;
}

export async function getAnalysis(instrument?: string): Promise<MarketAnalysis> {
    return fetchJson<MarketAnalysis>(analysisUrl(instrument));
}
