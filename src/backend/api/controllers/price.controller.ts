import { getPrice as getMarketPrice } from '../../market/market.service';
import { PriceResponseSchema } from '../schemas';

export async function getPrice() {
    const price = await getMarketPrice();

    return PriceResponseSchema.parse(price);
}
