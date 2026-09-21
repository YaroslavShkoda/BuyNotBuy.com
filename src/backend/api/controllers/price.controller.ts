import { getMarketData } from '../../market/market.service';

export async function getPrice() {
    const market = await getMarketData();

    return market.price;
}
