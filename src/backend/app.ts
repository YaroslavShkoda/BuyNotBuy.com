import Fastify from 'fastify';

import { priceRoutes } from './api/routes/price.js';
import { marketRoutes } from './api/routes/market.js';
import { analysisRoutes } from './api/routes/analysis.js';
import { signalHistoryRoutes } from './api/routes/signal-history.js';
import { instrumentRoutes } from './api/routes/instruments.js';
import { registerHealthRoutes } from './api/routes/health.js';
import { registerErrorHandler } from './api/error-handler.js';
import { registerRateLimit } from './api/middleware/rate-limit.plugin.js';
import { registerRequestContext } from './api/middleware/request-context.plugin.js';
import { applySecurityHeaders } from './api/middleware/security-headers.js';
import { applyCorsHeaders, registerPreflight } from './api/middleware/cors.js';
import { redactLogMethod } from './api/lib/redaction.js';
import { appConfig } from './config/app.config.js';

export function createApp(logDestination?: NodeJS.WritableStream) {
    const app = Fastify({
        logger: {
            level: 'info',
            ...(logDestination === undefined ? {} : { stream: logDestination }),
            // Redaction is installed on the logger itself rather than wrapped
            // around it. Fastify hands every request a logger derived from this
            // instance with `child()`, so a wrapper applied afterwards would
            // cover `app.log` and leave `request.log` — the scope the error
            // handler writes through — completely unfiltered. A hook set here
            // travels with the instance and therefore covers every child too.
            hooks: { logMethod: redactLogMethod },
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
    // Additive. The four above are the frozen contract and are untouched; this
    // one names an instrument, which none of them can do.
    app.register(instrumentRoutes);

    registerHealthRoutes(app);

    registerErrorHandler(app);

    return app;
}
