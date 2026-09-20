import type { FastifyInstance } from 'fastify';
import { marketDataProvider } from '../../market/market.provider'

export async function priceRoutes(app: FastifyInstance) {
    app.get('/api/price', async () => {
        const bitcoin = await marketDataProvider.getBitcoinPrice();

        return bitcoin;
    });
}