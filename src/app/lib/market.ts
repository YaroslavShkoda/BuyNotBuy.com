import type { Candle } from '../types/analysis';
import { fetchJson } from './api-error';

interface MarketResponse {
    price: {
        symbol: string;
        price: number;
    };
    candles: Candle[];
}

export async function getMarket(): Promise<MarketResponse> {
    return fetchJson<MarketResponse>(
        `${process.env.BACKEND_URL}/api/market`,
    );
}