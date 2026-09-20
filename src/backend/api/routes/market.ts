import type { FastifyInstance } from 'fastify';

import { getMarket } from '../controllers/market.controller';

export async function marketRoutes(
    app: FastifyInstance,
) {
    app.get('/api/market', async () => {
        return getMarket();
    });
}
