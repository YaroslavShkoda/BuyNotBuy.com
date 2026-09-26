import { getPrice as getMarketPrice } from '../../market/market.service.js';
import { PriceResponseSchema } from '../schemas.js';

export async function getPrice() {
    const price = await getMarketPrice();

    return PriceResponseSchema.parse(price);
}
