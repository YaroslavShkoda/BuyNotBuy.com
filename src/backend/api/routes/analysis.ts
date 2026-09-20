import type { FastifyInstance } from 'fastify';

import { getAnalysis } from '../controllers/analysis.controller';

export async function analysisRoutes(
    app: FastifyInstance,
) {
    app.get('/api/analysis', async () => {
        return getAnalysis();
    });
}
