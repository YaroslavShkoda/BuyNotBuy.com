import type { FastifyInstance } from 'fastify';

import { getPrice } from '../controllers/price.controller.js';

export async function priceRoutes(
    app: FastifyInstance,
) {
    app.get('/api/price', async () => {
        return getPrice();
    });
}
