import { getMarketData } from '../../market/market.service';
import { MarketDataSchema } from '../schemas';

export async function getMarket() {
    const marketData = await getMarketData();

    return MarketDataSchema.parse(marketData);
}
