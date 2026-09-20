import Fastify from 'fastify';

import { priceRoutes } from './api/routes/price';
import { marketRoutes } from './api/routes/market';
import { analysisRoutes } from './api/routes/analysis';

const app = Fastify({
    logger: true,
});

const PORT = 3001;

app.get('/', async () => {
    return {
        message: 'BuyNotBuy backend is running',
    };
});

async function startServer() {
    await app.register(priceRoutes);
    await app.register(marketRoutes);
    await app.register(analysisRoutes);

    try {
        const address = await app.listen({
            port: PORT,
        });

        console.log(`Server running at ${address}`);
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }
}

startServer();
