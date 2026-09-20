import Fastify from 'fastify';

import { priceRoutes } from './api/routes/price';
import { marketRoutes } from './api/routes/market';
import { analysisRoutes } from './api/routes/analysis';

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

    return app;
}
