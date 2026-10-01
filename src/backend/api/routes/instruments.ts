import type { FastifyInstance } from 'fastify';

import { instrumentPayload, instrumentsPayload } from '../controllers/instruments.controller.js';
import { InstrumentProblemSchema } from '../schemas.js';
import { sendWithEtag } from '../lib/conditional-get.js';

/**
 * `/api/instruments`, added alongside the frozen endpoints and in front of
 * nothing.
 *
 * **The old routes stay, and that is the requirement rather than a leftover.**
 * `/api/market` reads the configured market because that is what it was built
 * to do; `/api/instruments/:ticker` names one. Replacing the first with the
 * second would change what the dashboard draws, and the frontend is frozen — so
 * the pair is a compatibility layer by design, not debt.
 *
 * Tickers are normalised through `splitTicker` semantics the same way the
 * registry does, because a client that asks for `btcusdt` and gets a 404 for a
 * market the system trades every minute is a bug in the endpoint, not in the
 * caller. The repository keys on the uppercase form.
 */
export async function instrumentRoutes(app: FastifyInstance): Promise<void> {
    app.get('/api/instruments', async (request, reply) => {
        return sendWithEtag(request, reply, await instrumentsPayload());
    });

    app.get('/api/instruments/:ticker', async (request, reply) => {
        const { ticker } = request.params as { ticker: string };
        const found = await instrumentPayload(ticker.trim().toUpperCase());

        if (found === null) {
            // 404, not 200 with an empty body. A client that receives a
            // well-formed instrument object for a market that does not exist
            // will carry the lie further than a status code.
            //
            // The body is built and parsed through the same schema the test
            // checks it against, so the two cannot drift: a field added here
            // without a decision about whether it belongs to the contract fails
            // the suite instead of shipping.
            return reply
                .status(404)
                .send(
                    InstrumentProblemSchema.parse({
                        error: {
                            code: 'INSTRUMENT_NOT_FOUND',
                            message: `no instrument named "${ticker}" is in the registry`,
                            reason: null,
                        },
                    }),
                );
        }

        return found;
    });
}
