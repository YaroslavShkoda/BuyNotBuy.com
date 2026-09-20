import { createApp } from './app';

const PORT = 3001;

const app = createApp();

async function startServer() {
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
