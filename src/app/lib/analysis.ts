import type { MarketAnalysis } from '../types/analysis';

export async function getAnalysis(): Promise<MarketAnalysis> {
    const response = await fetch(
        `${process.env.BACKEND_URL}/api/analysis`,
        { cache: 'no-store' },
    );

    if (!response.ok) {
        throw new Error(
            `Backend returned ${response.status}`,
        );
    }

    return response.json() as Promise<MarketAnalysis>;
}
