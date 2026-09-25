import { createApp } from './app';
import { appConfig } from './config/app.config';
import { closeSignalHistoryRepository } from './history/signal-history.repository';

const app = createApp();

let isShuttingDown = false;

async function shutdown(): Promise<void> {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;

    try {
        await app.close();
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }

    // Release the process-wide SQLite handle so the database file is not
    // left locked on shutdown (Windows would otherwise block cleanup with
    // EPERM). Reopening on a later start is handled by the lazy singleton.
    closeSignalHistoryRepository();
}

process.on('SIGINT', () => {
    void shutdown();
});

process.on('SIGTERM', () => {
    void shutdown();
});

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
