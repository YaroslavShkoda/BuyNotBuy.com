import { afterEach, describe, expect, it, vi } from 'vitest';

// The database no longer has a path: it is a server named by DATABASE_URL, so
// there is no history file to anchor, point somewhere, or leave unset.
const HISTORY_ENV_KEYS = [
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
    it('retains a week of hourly snapshots and reads a day of them by default', async () => {
        vi.resetModules();
        clearHistoryEnv();

        const { historyConfig } = await import('./history.config');

        // 168 hourly buckets is a week; the default page of 24 covers the last
        // day, which is the window the stability summary talks about.
        expect(historyConfig.defaultLimit).toBe(24);
        expect(historyConfig.maxLimit).toBe(168);
        expect(historyConfig.maxEntries).toBe(720);
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
