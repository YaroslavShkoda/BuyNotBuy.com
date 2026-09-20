import type { FastifyInstance } from 'fastify';
import { getBitcoinPrice } from '../../market/binance.client';

export async function priceRoutes(app: FastifyInstance) {
    app.get('/api/price', async () => {
        const bitcoin = await getBitcoinPrice();

        return bitcoin;
    });
}