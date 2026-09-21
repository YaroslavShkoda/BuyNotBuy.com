import { describe, expect, it, vi } from 'vitest';

describe('appConfig', () => {
    it('loads default configuration', async () => {
        vi.resetModules();

        delete process.env.PORT;

        const { appConfig } = await import('./app.config');

        expect(appConfig).toEqual({
            port: 3001,
        });
    });

    it('loads configuration from environment variables', async () => {
        vi.resetModules();

        process.env.PORT = '4000';

        const { appConfig } = await import('./app.config');

        expect(appConfig).toEqual({
            port: 4000,
        });
    });

    it('rejects an invalid port', async () => {
        vi.resetModules();

        process.env.PORT = 'invalid';

        await expect(import('./app.config')).rejects.toThrow();
    });
});
