import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackendApiError, fetchJson } from './api-error';

afterEach(() => {
    vi.unstubAllGlobals();
});

function okResponse<T>(data: T) {
    return {
        ok: true,
        status: 200,
        json: async () => data,
    } as unknown as Response;
}

function errorResponse(status: number, json: () => Promise<unknown>) {
    return {
        ok: false,
        status,
        json,
    } as unknown as Response;
}

describe('fetchJson', () => {
    it('returns parsed JSON on 200 + valid JSON', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ price: 80000 })));

        const result = await fetchJson<{ price: number }>('http://backend/api/market');

        expect(result).toEqual({ price: 80000 });
    });

    it('passes cache no-store to fetch', async () => {
        const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
        vi.stubGlobal('fetch', fetchMock);

        await fetchJson('http://backend/api/market');

        expect(fetchMock).toHaveBeenCalledWith('http://backend/api/market', {
            cache: 'no-store',
        });
    });

    it('throws BackendApiError on 4xx + valid API error body', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                errorResponse(400, async () => ({
                    error: { code: 'VALIDATION_ERROR', message: 'Invalid market data response' },
                })),
            ),
        );

        const error = (await fetchJson('http://backend/api/market').catch((e: unknown) => e)) as BackendApiError;

        expect(error).toBeInstanceOf(BackendApiError);
        expect(error.status).toBe(400);
        expect(error.code).toBe('VALIDATION_ERROR');
    });

    it('throws BackendApiError on 5xx + valid API error body', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                errorResponse(503, async () => ({
                    error: { code: 'MARKET_DATA_UNAVAILABLE', message: 'Market data is temporarily unavailable' },
                })),
            ),
        );

        const error = (await fetchJson('http://backend/api/analysis').catch((e: unknown) => e)) as BackendApiError;

        expect(error).toBeInstanceOf(BackendApiError);
        expect(error.status).toBe(503);
        expect(error.code).toBe('MARKET_DATA_UNAVAILABLE');
    });

    it('throws generic error on 5xx + malformed body', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(errorResponse(503, async () => {
                throw new Error('Unexpected token');
            })),
        );

        const error = (await fetchJson('http://backend/api/market').catch((e: unknown) => e)) as Error;

        expect(error).not.toBeInstanceOf(BackendApiError);
        expect(error.message).toBe('Backend returned 503');
    });

    it('throws normalized error on 200 + malformed JSON', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => {
                    throw new SyntaxError('Unexpected token in JSON');
                },
            } as unknown as Response),
        );

        const error = (await fetchJson('http://backend/api/market').catch((e: unknown) => e)) as Error;

        expect(error.message).toBe('Backend returned invalid JSON');
        expect(error.cause).toBeInstanceOf(SyntaxError);
    });

    it('throws normalized error on empty response body', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => {
                    throw new SyntaxError('Unexpected end of JSON input');
                },
            } as unknown as Response),
        );

        const error = (await fetchJson('http://backend/api/market').catch((e: unknown) => e)) as Error;

        expect(error.message).toBe('Backend returned invalid JSON');
    });

    it('lets network failure propagate to the error boundary', async () => {
        const networkError = new TypeError('fetch failed');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

        const error = (await fetchJson('http://backend/api/market').catch((e: unknown) => e)) as Error;

        expect(error).toBe(networkError);
    });
});
