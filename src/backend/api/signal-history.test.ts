import { marketConfig } from '../config/market.config.js';
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
        provider: marketConfig.provider,
        interval: marketConfig.candleInterval,
        context: {
            regime: null,
            dataQuality: null,
            dataQualityUsable: null,
            dataQualityWorst: null,
        },
        ...overrides,
    };
}

describe('GET /api/signal-history', () => {
    beforeEach(() => {
        // Reset rather than clear, and an explicit default on top of it. `clear`
        // forgets the calls and keeps the implementation, so a test that answers
        // with entries leaked them into the next one — which is how "a custom
        // limit" ended up receiving rows it never asked for.
        mockGetSignalHistory.mockReset();
        mockGetSignalHistory.mockResolvedValue([]);
    });

    it('describes the market the client named, and only that one', async () => {
        // **This is the item.** The route took no instrument, so it answered about
        // `marketConfig.symbol` — a full, well-formed history with real numbers,
        // describing BTCUSDT to a client that had never asked about a market. In a
        // process observing two markets, the other one is published, snapshotted
        // and settled every minute and cannot be read here at all.
        mockGetSignalHistory.mockResolvedValue([
            makeEntry({ symbol: 'ETHUSDT', price: 3_000 }),
        ]);

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/signal-history?instrument=ETHUSDT',
        });

        expect(response.statusCode).toBe(200);

        // Both the walk-back over the whole record and the page carry the market.
        // Missing it on either is a page from one market summarised against
        // another's entries.
        expect(mockGetSignalHistory).toHaveBeenCalledWith(
            historyConfig.maxEntries,
            undefined,
            'ETHUSDT',
        );
        expect(response.json().entries[0]?.symbol).toBe('ETHUSDT');

        await app.close();
    });

    it('refuses a ticker it cannot parse, rather than answering with an empty history', async () => {
        // The other half. An unknown market returning "no history" is a different
        // fact about a different thing from "this market has never signalled", and
        // a dashboard renders the first as a quiet series.
        //
        // The refusal comes from the asset registry, the same one the
        // configuration layer uses at boot — so "a name nobody can parse" means one
        // thing in this system instead of two.
        mockGetSignalHistory.mockResolvedValue([]);

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/signal-history?instrument=NOTAREALTICKER',
        });

        expect(response.statusCode).toBe(400);
        expect(mockGetSignalHistory).not.toHaveBeenCalled();

        await app.close();
    });

    it('keeps the configured market when the client names nothing', async () => {
        // The default is the claim everything above preserves: a frozen client
        // that sends no instrument gets exactly what it got before.
        mockGetSignalHistory.mockResolvedValue([makeEntry()]);

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/signal-history',
        });

        expect(response.statusCode).toBe(200);
        expect(mockGetSignalHistory).toHaveBeenCalledWith(
            historyConfig.maxEntries,
            undefined,
            marketConfig.symbol,
        );

        await app.close();
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
        // The stored entry carries the series and the market context; the
        // published response does not. The schema strips what the contract has
        // never declared, so a client that started receiving `regime` here
        // would be a change to the API rather than an addition to the storage,
        // and the dashboard is not ours to move underneath.
        expect(response.json()).toEqual({
            entries: [
                {
                    timestamp: entry.timestamp,
                    symbol: entry.symbol,
                    signal: entry.signal,
                    consensus: entry.consensus,
                    price: entry.price,
                },
            ],
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
        // The market travels with the call. It is the whole point: the read used
        // to name no market at all, so a process observing two answered this
        // question about one of them while publishing both.
        expect(mockGetSignalHistory).toHaveBeenCalledWith(
            historyConfig.maxEntries,
            undefined,
            'BTCUSDT',
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
        // The market travels with the call. It is the whole point: the read used
        // to name no market at all, so a process observing two answered this
        // question about one of them while publishing both.
        expect(mockGetSignalHistory).toHaveBeenCalledWith(
            historyConfig.maxEntries,
            undefined,
            'BTCUSDT',
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
