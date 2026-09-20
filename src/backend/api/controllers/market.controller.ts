import { getMarketSnapshot } from '../../market/market.service';

export async function getMarket() {
    return getMarketSnapshot();
}
