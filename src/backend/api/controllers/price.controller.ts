import { marketDataProvider } from '../../market/market.provider';

export async function getPrice() {
    return marketDataProvider.getBitcoinPrice();
}
