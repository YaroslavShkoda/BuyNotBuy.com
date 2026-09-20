import type { FastifyInstance } from 'fastify';

import { getPrice } from '../controllers/price.controller';

export async function priceRoutes(
    app: FastifyInstance,
) {
    app.get('/api/price', async () => {
        return getPrice();
    });
}
