import type { FastifyInstance } from 'fastify';
import { appConfig } from '../config/app.config.js';
import { prepareDatabase } from './database.js';
import { prepareRegistry } from './registry.js';
import { registerShutdownHandlers } from './shutdown.js';
import { createMarketWorkers, type MarketWorkers } from './workers.js';

/**
 * The runtime, as one object with one verb.
 *
 * The composition the server used to inline: prove the database answers and
 * replay what the last process left, write the registry down, open the
 * socket, start the loops — and register the shutdown that undoes it in
 * reverse. None of those steps know about HTTP, so none of them live in the
 * server file anymore; this file is where they learn their order.
 */
interface Runtime {
    start(): Promise<void>;
}

export async function createRuntime(app: FastifyInstance): Promise<Runtime> {
    const workers: MarketWorkers = createMarketWorkers(app.log);

    registerShutdownHandlers({
        log: app.log,
        workers,
        closeApp: () => app.close(),
    });

    return {
        async start(): Promise<void> {
            try {
                await prepareDatabase(app.log);
                await prepareRegistry(app.log);

                const address = await app.listen({
                    port: appConfig.port,
                    host: appConfig.host,
                });

                console.log(`Server running at ${address}`);

                await workers.start();
            } catch (error) {
                app.log.error(error);
                process.exit(1);
            }
        },
    };
}
