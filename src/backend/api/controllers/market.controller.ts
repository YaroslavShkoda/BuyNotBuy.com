import { getMarketData } from '../../market/market.service';

export async function getMarket() {
    return getMarketData();
}
