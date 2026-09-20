import Fastify from 'fastify';

import { priceRoutes } from './api/routes/price';
import { marketRoutes } from './api/routes/market';
import { analysisRoutes } from './api/routes/analysis';

import { MarketDataError } from './errors/market-data.error';

export function createApp() {
    const app = Fastify({
        logger: true,
    });

    app.get('/', async () => {
        return {
            message: 'BuyNotBuy backend is running',
        };
    });

    app.register(priceRoutes);
    app.register(marketRoutes);
    app.register(analysisRoutes);

    app.setErrorHandler((error, request, reply) => {
        request.log.error(error);

        if (error instanceof MarketDataError) {
            return reply.status(502).send({
                error: 'Market data provider unavailable',
            });
        }

        return reply.status(500).send({
            error: 'Internal server error',
        });
    });

    return app;
}
