import type { Candle } from '../../backend/types/market';

interface MarketResponse {
    price: {
        symbol: string;
        price: number;
    };
    candles: Candle[];
}

export async function getMarket(): Promise<MarketResponse> {
    const response = await fetch(
        `${process.env.BACKEND_URL}/api/market`,
        { cache: 'no-store' },
    );

    if (!response.ok) {
        throw new Error(
            `Backend returned ${response.status}`,
        );
    }

    return response.json() as Promise<MarketResponse>;
}