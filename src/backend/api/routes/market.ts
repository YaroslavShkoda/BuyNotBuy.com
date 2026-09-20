import type { FastifyInstance } from 'fastify';
import { getMarketSnapshot } from '../../market/market.service';

export async function marketRoutes(app: FastifyInstance) {
    app.get('/api/market', async () => {
        return getMarketSnapshot();
    });
}