import type { FastifyInstance } from 'fastify';

import { analyzeMarket } from '../../services/analysis.service';

export async function analysisRoutes(
    app: FastifyInstance,
) {
    app.get('/api/analysis', async () => {
        return analyzeMarket();
    });
}
