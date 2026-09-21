import { createApp } from './app';
import { appConfig } from './config/app.config';

const app = createApp();

async function startServer() {
    try {
        const address = await app.listen({
            port: appConfig.port,
        });

        console.log(`Server running at ${address}`);
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }
}

startServer();
