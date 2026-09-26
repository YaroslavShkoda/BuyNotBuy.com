import type { FastifyInstance } from 'fastify';

import { getSignalHistory } from '../controllers/signal-history.controller.js';

export async function signalHistoryRoutes(
    app: FastifyInstance,
) {
    app.get('/api/signal-history', async (request) => {
        return getSignalHistory(
            request.query,
            request.log,
        );
    });
}
