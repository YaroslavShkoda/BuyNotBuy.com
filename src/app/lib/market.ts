import type { Candle } from '../types/analysis';
import { fetchJson } from './api-error';

interface MarketResponse {
    price: {
        symbol: string;
        price: number;
    };
    candles: Candle[];
}

export function marketUrl(instrument?: string): string {
    const base = process.env.BACKEND_URL;

    return instrument === undefined
        ? `${base}/api/market`
        : `${base}/api/instruments/${encodeURIComponent(instrument)}/market`;
}

export async function getMarket(instrument?: string): Promise<MarketResponse> {
    return fetchJson<MarketResponse>(marketUrl(instrument));
}