import Fastify from 'fastify';

import { priceRoutes } from './api/routes/price.js';
import { marketRoutes } from './api/routes/market.js';
import { analysisRoutes } from './api/routes/analysis.js';
import { signalHistoryRoutes } from './api/routes/signal-history.js';
import { registerHealthRoutes } from './api/routes/health.js';
import { registerErrorHandler } from './api/error-handler.js';
import { registerRateLimit } from './api/middleware/rate-limit.plugin.js';
import {
    redactLogger,
    registerRequestContext,
} from './api/middleware/request-context.plugin.js';
import { applySecurityHeaders } from './api/middleware/security-headers.js';
import { applyCorsHeaders, registerPreflight } from './api/middleware/cors.js';
import { appConfig } from './config/app.config.js';

export function createApp() {    const app = Fastify({
        // Redaction sits between the call sites and the sink, so a value that
        // arrives inside an exception cannot reach a log file unfiltered.
        logger: {
            level: 'info',
        },
        bodyLimit: appConfig.bodyLimitBytes,
        connectionTimeout: appConfig.connectionTimeoutMs,
        requestTimeout: appConfig.requestTimeoutMs,
        keepAliveTimeout: appConfig.keepAliveTimeoutMs,
        // Off unless a proxy in front of this service is known to overwrite
        // the header: trusting a client-supplied one would let anyone rotate
        // their apparent address and bypass the rate limit.
        trustProxy: appConfig.trustProxy,
    });

    app.log = redactLogger(app.log) as typeof app.log;

    // Security headers go on first so they are present even when a later hook
    // throws, and so a failed request is still not sniffable or framable.
    app.addHook('onRequest', async (request, reply) => {
        applyCorsHeaders(request, reply);
        applySecurityHeaders(reply);
    });

    // Answered before routing so a preflight never has to match a real route.
    app.options('/*', async (request, reply) => registerPreflight(reply, request));

    app.get('/', async () => {
        return {
            message: 'BuyNotBuy backend is running',
        };
    });

    registerRequestContext(app);
    registerRateLimit(app);

    app.register(priceRoutes);
    app.register(marketRoutes);
    app.register(analysisRoutes);
    app.register(signalHistoryRoutes);

    registerHealthRoutes(app);

    registerErrorHandler(app);

    return app;
}
