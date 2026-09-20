export interface MarketConfig {
    baseUrl: string;
    symbol: string;
    candleInterval: string;
    defaultCandleLimit: number;
}

export const marketConfig: MarketConfig = {
    baseUrl: 'https://data-api.binance.vision',
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    defaultCandleLimit: 300,
};
