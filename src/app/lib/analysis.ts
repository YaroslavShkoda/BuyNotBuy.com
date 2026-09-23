import type { MarketAnalysis } from '../types/analysis';
import { fetchJson } from './api-error';

export async function getAnalysis(): Promise<MarketAnalysis> {
    return fetchJson<MarketAnalysis>(
        `${process.env.BACKEND_URL}/api/analysis`,
    );
}
