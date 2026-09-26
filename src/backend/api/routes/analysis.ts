import type { FastifyInstance } from 'fastify';

import { getAnalysis } from '../controllers/analysis.controller.js';

import {
    setDataFreshnessHeaders,
} from '../lib/data-freshness.js';
import { sendWithEtag } from '../lib/conditional-get.js';

export async function analysisRoutes(
    app: FastifyInstance,
) {
    app.get('/api/analysis', async (request, reply) => {
        const { payload, stale, ageMs } = await getAnalysis(
            request.log,
            request.id,
        );

        // Freshness is set before the conditional check so a 304 still says
        // whether the answer behind it is old. A client that skips the body
        // has lost nothing else, and dropping the header would leave it unable
        // to tell "unchanged and fresh" from "unchanged and stale".
        setDataFreshnessHeaders(reply, stale, ageMs);

        return sendWithEtag(request, reply, payload, {
            // The analysis stamps the moment it was computed into the body.
            // Left in the comparison, every request would carry a different
            // tag and the client would never see a single 304.
            volatileFields: ['timestamp'],
        });
    });
}
