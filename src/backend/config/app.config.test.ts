import { describe, expect, it, vi } from 'vitest';

const DEFAULT_CONFIG = {
    port: 3001,
    host: '0.0.0.0',
    bodyLimitBytes: 16384,
    connectionTimeoutMs: 10000,
    requestTimeoutMs: 60000,
    keepAliveTimeoutMs: 5000,
    rateLimitMax: 300,
    rateLimitWindowMs: 60000,
    corsOrigins: [],
    hstsMaxAgeSeconds: 0,
    trustProxy: false,
};

const ENV_KEYS = [
    'PORT',
    'HOST',
    'APP_BODY_LIMIT_BYTES',
    'APP_CONNECTION_TIMEOUT_MS',
    'APP_REQUEST_TIMEOUT_MS',
    'APP_KEEPALIVE_TIMEOUT_MS',
    'APP_RATE_LIMIT_MAX',
    'APP_RATE_LIMIT_WINDOW_MS',
    'APP_CORS_ORIGINS',
    'APP_HSTS_MAX_AGE',
    'APP_TRUST_PROXY',
] as const;

function clearEnv(): void {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
}

describe('appConfig', () => {
    it('loads default configuration', async () => {
        vi.resetModules();
        clearEnv();

        const { appConfig } = await import('./app.config');

        expect(appConfig).toEqual(DEFAULT_CONFIG);
    });

    it('listens on every interface by default so a container is reachable', async () => {
        vi.resetModules();
        clearEnv();

        const { appConfig } = await import('./app.config');

        // Binding loopback only would make the service work locally and fail
        // silently the moment it is put in a container.
        expect(appConfig.host).toBe('0.0.0.0');
    });

    it('refuses every cross-origin reader by default', async () => {
        vi.resetModules();
        clearEnv();

        const { appConfig } = await import('./app.config');

        // The dashboard calls this API server-side, so no browser origin needs
        // access and the safest list is the empty one.
        expect(appConfig.corsOrigins).toEqual([]);
    });

    it('loads configuration from environment variables', async () => {
        vi.resetModules();
        clearEnv();

        process.env.PORT = '4000';
        process.env.HOST = '127.0.0.1';
        process.env.APP_BODY_LIMIT_BYTES = '2048';
        process.env.APP_CONNECTION_TIMEOUT_MS = '3000';
        process.env.APP_REQUEST_TIMEOUT_MS = '90000';
        process.env.APP_KEEPALIVE_TIMEOUT_MS = '1000';
        process.env.APP_RATE_LIMIT_MAX = '10';
        process.env.APP_RATE_LIMIT_WINDOW_MS = '1000';
        process.env.APP_CORS_ORIGINS = 'https://a.example, https://b.example';
        process.env.APP_HSTS_MAX_AGE = '31536000';
        process.env.APP_TRUST_PROXY = 'true';

        const { appConfig } = await import('./app.config');

        expect(appConfig).toEqual({
            port: 4000,
            host: '127.0.0.1',
            bodyLimitBytes: 2048,
            connectionTimeoutMs: 3000,
            requestTimeoutMs: 90000,
            keepAliveTimeoutMs: 1000,
            rateLimitMax: 10,
            rateLimitWindowMs: 1000,
            corsOrigins: ['https://a.example', 'https://b.example'],
            hstsMaxAgeSeconds: 31536000,
            trustProxy: true,
        });

        clearEnv();
    });

    it('ignores blank CORS entries', async () => {
        vi.resetModules();
        clearEnv();

        process.env.APP_CORS_ORIGINS = ' https://ok.example , ,https://two.example ';

        const { appConfig } = await import('./app.config');

        expect(appConfig.corsOrigins).toEqual([
            'https://ok.example',
            'https://two.example',
        ]);

        clearEnv();
    });

    it('rejects a CORS list containing something that is not a URL', async () => {
        vi.resetModules();
        clearEnv();

        process.env.APP_CORS_ORIGINS = 'https://ok.example, not-a-url';

        // A value that can never match a browser's Origin header would only
        // hide a configuration mistake, so it is refused outright.
        await expect(import('./app.config')).rejects.toThrow();

        clearEnv();
    });

    it('trusts the proxy header only when explicitly switched on', async () => {
        vi.resetModules();
        clearEnv();

        process.env.APP_TRUST_PROXY = 'true';

        const { appConfig } = await import('./app.config');

        expect(appConfig.trustProxy).toBe(true);

        clearEnv();
    });

    it('treats any other value of the proxy switch as off', async () => {
        vi.resetModules();
        clearEnv();

        process.env.APP_TRUST_PROXY = 'yes';

        const { appConfig } = await import('./app.config');

        // Only the exact word enables it: a typo must fail closed.
        expect(appConfig.trustProxy).toBe(false);

        clearEnv();
    });

    it.each([
        { key: 'PORT', value: 'invalid' },
        { key: 'PORT', value: '-1' },
        { key: 'HOST', value: '' },
        { key: 'APP_BODY_LIMIT_BYTES', value: '0' },
        { key: 'APP_BODY_LIMIT_BYTES', value: '-1' },
        { key: 'APP_CONNECTION_TIMEOUT_MS', value: '0' },
        { key: 'APP_REQUEST_TIMEOUT_MS', value: '0' },
        { key: 'APP_KEEPALIVE_TIMEOUT_MS', value: '-1' },
        { key: 'APP_RATE_LIMIT_MAX', value: '0' },
        { key: 'APP_RATE_LIMIT_WINDOW_MS', value: '0' },
        { key: 'APP_HSTS_MAX_AGE', value: '-1' },
    ])('rejects $key=$value', async ({ key, value }) => {
        vi.resetModules();
        clearEnv();

        process.env[key] = value;

        await expect(import('./app.config')).rejects.toThrow();

        clearEnv();
    });
});
