import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `market.config` reads the environment and throws at import, so each case has
 * to re-import it. The module registry is reset per case rather than shared,
 * because the whole point of the guard is which environment it saw.
 */
const ORIGINAL_ENV = { ...process.env };

async function importWithEnv(env: Record<string, string | undefined>) {
    vi.resetModules();

    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    return import('./market.config.js');
}

beforeEach(() => {
    process.env.MARKET_PROVIDER = 'binance';
    delete process.env.MARKET_ALLOW_MOCK;
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
});

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) {
            delete process.env[key];
        }
    }

    Object.assign(process.env, ORIGINAL_ENV);
    vi.resetModules();
});

describe('mock provider guard', () => {
    it('refuses a mock primary outside the test suite', async () => {
        process.env.MARKET_PROVIDER = 'mock';

        // A mock primary serves 900 synthetic candles that pass every
        // integrity check — increasing, finite, internally consistent — and
        // reports them as live with no staleness flag. Nothing on the page
        // would look wrong, which is the point.
        await expect(importWithEnv({})).rejects.toThrow(
            /MARKET_PROVIDER=mock is not allowed/,
        );
    });

    it('refuses a mock primary even when the environment says production', async () => {
        await expect(
            importWithEnv({ MARKET_PROVIDER: 'mock', NODE_ENV: 'production' }),
        ).rejects.toThrow(/not allowed outside the test suite/);
    });

    it('allows a mock primary in the test suite', async () => {
        const { marketConfig } = await importWithEnv({
            MARKET_PROVIDER: 'mock',
            VITEST: 'true',
        });

        expect(marketConfig.provider).toBe('mock');
    });

    it('allows a mock primary when the operator says so explicitly', async () => {
        const { marketConfig } = await importWithEnv({
            MARKET_PROVIDER: 'mock',
            MARKET_ALLOW_MOCK: '1',
        });

        expect(marketConfig.provider).toBe('mock');
    });

    it('still refuses a mock in the backup list', async () => {
        // The half of the guard that already existed, kept: a backup that took
        // over would be just as invisible as a mock that never left.
        await expect(
            importWithEnv({
                MARKET_PROVIDER: 'binance',
                MARKET_FALLBACK_PROVIDERS: 'bitget,mock',
                MARKET_ALLOW_MOCK: '1',
            }),
        ).rejects.toThrow(/cannot include "mock"/);
    });

    it('leaves a real primary alone', async () => {
        const { marketConfig } = await importWithEnv({
            MARKET_PROVIDER: 'bitget',
        });

        expect(marketConfig.provider).toBe('bitget');
    });
});
