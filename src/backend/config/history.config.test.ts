import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAbsolute, sep } from 'node:path';

const HISTORY_ENV_KEYS = [
    'HISTORY_DB_PATH',
    'HISTORY_DEFAULT_LIMIT',
    'HISTORY_MAX_LIMIT',
    'HISTORY_MAX_ENTRIES',
    'HISTORY_MAX_BUFFERED_ENTRIES',
    'MARKET_POLL_ENABLED',
    'MARKET_POLL_INTERVAL_MS',
] as const;

function clearHistoryEnv(): void {
    for (const key of HISTORY_ENV_KEYS) {
        delete process.env[key];
    }
}

afterEach(() => {
    clearHistoryEnv();
});

describe('historyConfig', () => {
    it('anchors the database outside the working directory', async () => {
        vi.resetModules();
        clearHistoryEnv();

        const { historyConfig } = await import('./history.config');

        // A systemd unit or a container entrypoint starts the process from
        // `/`; a relative path would put the database somewhere nobody looks.
        expect(isAbsolute(historyConfig.databasePath)).toBe(true);
        expect(historyConfig.databasePath.endsWith(`${sep}data${sep}signal-history.db`)).toBe(true);
    });

    it('lets an explicit path override the default', async () => {
        vi.resetModules();
        clearHistoryEnv();

        process.env.HISTORY_DB_PATH = '/tmp/custom-history.db';

        const { historyConfig } = await import('./history.config');

        expect(historyConfig.databasePath).toBe('/tmp/custom-history.db');

        clearHistoryEnv();
    });

    it('treats an assigned but empty path as unset', async () => {
        vi.resetModules();
        clearHistoryEnv();

        // `.env.example` ships `HISTORY_DB_PATH=` to mean "use the default",
        // and `node --env-file` hands that over as an empty string rather than
        // an absent variable. Reading it with `??` let the empty string reach
        // the schema and the service refused to start.
        process.env.HISTORY_DB_PATH = '';

        const { historyConfig } = await import('./history.config');

        expect(historyConfig.databasePath.endsWith(`${sep}data${sep}signal-history.db`)).toBe(true);

        clearHistoryEnv();
    });

    it('runs the poller once a minute by default', async () => {
        vi.resetModules();
        clearHistoryEnv();

        const { historyConfig } = await import('./history.config');

        // Hourly candles mean a faster poll buys nothing but upstream weight.
        expect(historyConfig.pollEnabled).toBe(true);
        expect(historyConfig.pollIntervalMs).toBe(60_000);
    });

    it('can be switched off for one-off runs and tests', async () => {
        vi.resetModules();
        clearHistoryEnv();

        process.env.MARKET_POLL_ENABLED = 'false';

        const { historyConfig } = await import('./history.config');

        // A timer would keep a script alive long after its work is done.
        expect(historyConfig.pollEnabled).toBe(false);

        clearHistoryEnv();
    });

    it('refuses a poll interval fast enough to hammer the provider', async () => {
        vi.resetModules();
        clearHistoryEnv();

        process.env.MARKET_POLL_INTERVAL_MS = '10';

        await expect(import('./history.config')).rejects.toThrow();

        clearHistoryEnv();
    });

    it('bounds the write backlog', async () => {
        vi.resetModules();
        clearHistoryEnv();

        const { historyConfig } = await import('./history.config');

        // A long database outage must not become unbounded memory growth.
        expect(historyConfig.maxBufferedEntries).toBeGreaterThan(0);
        expect(historyConfig.maxBufferedEntries).toBeLessThanOrEqual(
            historyConfig.maxEntries,
        );
    });

    it('rejects a backlog larger than the history it protects', async () => {
        vi.resetModules();
        clearHistoryEnv();

        process.env.HISTORY_MAX_ENTRIES = '10';
        process.env.HISTORY_MAX_BUFFERED_ENTRIES = '0';

        await expect(import('./history.config')).rejects.toThrow();

        clearHistoryEnv();
    });
});
