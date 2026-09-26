import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockGetSignalHistory } = vi.hoisted(() => ({
    mockGetSignalHistory: vi.fn((): unknown => []),
}));

vi.mock('../history/signal-history.service.js', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('../history/signal-history.service')
    >();

    return {
        recordSignalHistory: vi.fn(),
        getSignalHistory: mockGetSignalHistory,
        summarizeHistory: actual.summarizeHistory,
    };
});

import { createApp } from '../app.js';
import { historyConfig } from '../config/history.config.js';

import type { SignalHistoryEntry } from '../history/signal-history.types.js';

function makeEntry(overrides: Partial<SignalHistoryEntry> = {}): SignalHistoryEntry {
    return {
        timestamp: 1_737_950_400_000,
        symbol: 'BTCUSDT',
        signal: 'SHORT',
        consensus: 67,
        price: 100_000,
        ...overrides,
    };
}

describe('GET /api/signal-history', () => {
    beforeEach(() => {
        mockGetSignalHistory.mockClear();
    });

    it('returns recorded entries with the default limit', async () => {
        const entry = makeEntry();
        mockGetSignalHistory.mockReturnValueOnce([entry]);

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/signal-history',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            entries: [entry],
            summary: {
                currentSignal: 'SHORT',
                // A single record proves the signal is current but not how
                // long it has held.
                currentDurationHours: 0,
                currentDurationBounded: false,
                changes24h: 0,
                lastTransition: null,
                previousDurationHours: null,
                previousDurationBounded: false,
                sampleHours: 0,
            },
            // No more rows behind the single one, so the walk is over.
            nextCursor: null,
        });

        // A single query serves both: the page is a prefix of the full record
        // the summary is built from, so there is nothing left to ask for.
        expect(mockGetSignalHistory).toHaveBeenCalledTimes(1);
        expect(mockGetSignalHistory).toHaveBeenCalledWith(
            historyConfig.maxEntries,
        );

        await app.close();
    });

    it('passes a valid custom limit through to the service', async () => {
        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/signal-history?limit=5',
        });

        expect(response.statusCode).toBe(200);
        // The limit trims the page, not the read, so the summary still sees
        // the whole record.
        expect(response.json().entries).toHaveLength(0);
        expect(mockGetSignalHistory).toHaveBeenCalledWith(
            historyConfig.maxEntries,
        );

        await app.close();
    });

    it('rejects a limit above the maximum', async () => {
        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: `/api/signal-history?limit=${historyConfig.maxLimit + 1}`,
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
            error: {
                code: 'INVALID_REQUEST',
                message: 'Invalid request parameters',
            },
        });

        await app.close();
    });

    it('rejects a non-numeric limit', async () => {
        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/signal-history?limit=abc',
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('INVALID_REQUEST');

        await app.close();
    });

    it('rejects a zero, negative and fractional limit', async () => {
        const app = createApp();

        for (const limit of ['0', '-1', '1.5']) {
            const response = await app.inject({
                method: 'GET',
                url: `/api/signal-history?limit=${limit}`,
            });

            expect(response.statusCode).toBe(400);
            expect(response.json().error.code).toBe('INVALID_REQUEST');
        }

        expect(mockGetSignalHistory).not.toHaveBeenCalled();

        await app.close();
    });

    it('returns an empty entry list when history is empty', async () => {
        mockGetSignalHistory.mockReturnValueOnce([]);

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/signal-history',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            entries: [],
            summary: {
                currentSignal: null,
                currentDurationHours: null,
                currentDurationBounded: false,
                changes24h: 0,
                lastTransition: null,
                previousDurationHours: null,
                previousDurationBounded: false,
                sampleHours: 0,
            },
            nextCursor: null,
        });

        await app.close();
    });

    it('maps an internal history failure to a stable public error without internals', async () => {
        mockGetSignalHistory.mockImplementationOnce(() => {
            throw new Error('database disk I/O error SECRET_CONNECTION_STRING');
        });

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/signal-history',
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Internal server error',
            },
        });

        expect(response.body).not.toContain('SECRET_CONNECTION_STRING');

        await app.close();
    });
});
