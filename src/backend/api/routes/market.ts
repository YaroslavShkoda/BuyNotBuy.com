import type { FastifyInstance } from 'fastify';

import { getMarket } from '../controllers/market.controller.js';

import {
    setDataFreshnessHeaders,
} from '../lib/data-freshness.js';
import { sendWithEtag } from '../lib/conditional-get.js';

export async function marketRoutes(
    app: FastifyInstance,
) {
    app.get('/api/market', async (request, reply) => {
        const { payload, stale, ageMs } = await getMarket();

        // Freshness is set before the conditional check so a 304 still says
        // whether the answer behind it is old. A client that skips the body
        // has lost nothing else, and dropping the header would leave it unable
        // to tell "unchanged and fresh" from "unchanged and stale".
        setDataFreshnessHeaders(reply, stale, ageMs);

        return sendWithEtag(request, reply, payload);
    });
}
