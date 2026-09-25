import Fastify from 'fastify';

import { priceRoutes } from './api/routes/price';
import { marketRoutes } from './api/routes/market';
import { analysisRoutes } from './api/routes/analysis';
import { signalHistoryRoutes } from './api/routes/signal-history';
import { registerErrorHandler } from './api/error-handler';

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
    app.register(signalHistoryRoutes);

    registerErrorHandler(app);

    return app;
}
