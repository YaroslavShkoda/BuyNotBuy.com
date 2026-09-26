import { z } from 'zod';

const AppConfigSchema = z.object({
    port: z.coerce.number().int().positive(),

    /**
     * Bound on where the server listens. `0.0.0.0` is what makes the service
     * reachable from outside a container, which is the normal deployment and
     * not something to opt into.
     */
    host: z.string().min(1),

    /**
     * This API only reads; it never accepts a body. A small limit means a
     * client cannot make the process buffer an arbitrary payload before the
     * router ever sees the request.
     */
    bodyLimitBytes: z.coerce.number().int().positive(),

    /** How long a client may take to deliver a full request. */
    connectionTimeoutMs: z.coerce.number().int().positive(),

    /**
     * Hard ceiling on one request. Must stay above the worst case the market
     * transport can take — every retry plus every timeout — or the server
     * would cut off a request the transport was about to answer.
     */
    requestTimeoutMs: z.coerce.number().int().positive(),

    keepAliveTimeoutMs: z.coerce.number().int().positive(),

    /** Requests allowed per client per window. */
    rateLimitMax: z.coerce.number().int().positive(),

    rateLimitWindowMs: z.coerce.number().int().positive(),

    /**
     * Origins allowed to read this API from a browser. Empty by default: the
     * dashboard calls the backend server-side, so no cross-origin reader is
     * needed and refusing all of them is the safe default.
     */
    corsOrigins: z.array(z.string().url()),

    /**
     * `Strict-Transport-Security` lifetime. Zero disables it, which is right
     * for a plain-HTTP development server; set it when TLS terminates in front.
     */
    hstsMaxAgeSeconds: z.coerce.number().int().min(0),

    /**
     * Whether to believe `X-Forwarded-For`. Off by default: trusting it without
     * a proxy that overwrites it lets any client claim a fresh address and walk
     * straight past the rate limit.
     */
    trustProxy: z.boolean(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

function parseCorsOrigins(raw: string | undefined): string[] {
    return (raw ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== '');
}

export const appConfig: AppConfig = AppConfigSchema.parse({
    port:
        process.env.PORT ??
        '3001',

    host:
        process.env.HOST ??
        '0.0.0.0',

    bodyLimitBytes:
        process.env.APP_BODY_LIMIT_BYTES ??
        '16384',

    connectionTimeoutMs:
        process.env.APP_CONNECTION_TIMEOUT_MS ??
        '10000',

    requestTimeoutMs:
        process.env.APP_REQUEST_TIMEOUT_MS ??
        '60000',

    keepAliveTimeoutMs:
        process.env.APP_KEEPALIVE_TIMEOUT_MS ??
        '5000',

    rateLimitMax:
        process.env.APP_RATE_LIMIT_MAX ??
        '300',

    rateLimitWindowMs:
        process.env.APP_RATE_LIMIT_WINDOW_MS ??
        '60000',

    corsOrigins: parseCorsOrigins(process.env.APP_CORS_ORIGINS),

    hstsMaxAgeSeconds:
        process.env.APP_HSTS_MAX_AGE ??
        '0',

    trustProxy:
        (process.env.APP_TRUST_PROXY ?? 'false') === 'true',
});
