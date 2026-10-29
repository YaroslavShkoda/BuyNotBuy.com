import { readFileSync } from 'node:fs';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: () => undefined }),
    notFound: () => {
        throw new Error('NEXT_NOT_FOUND');
    },
}));

vi.mock('next/link', () => ({
    default: () => null,
}));

vi.mock('next/image', () => ({
    default: () => null,
}));

import MarketPage from './page';

const pageSource = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
const retrySource = readFileSync(new URL('../../components/retry-button.tsx', import.meta.url), 'utf8');
const loadingSource = readFileSync(new URL('./loading.tsx', import.meta.url), 'utf8');

function okResponse(data: unknown) {
    return {
        ok: true,
        status: 200,
        json: async () => data,
    } as unknown as Response;
}

function errorResponse(status: number, code: string, message: string) {
    return {
        ok: false,
        status,
        json: async () => ({ error: { code, message } }),
    } as unknown as Response;
}

function unreachable() {
    return 'http://backend.test';
}

function stubBackendFetch(routes: (url: string) => Promise<Response> | Response) {
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
        const url = String(input);

        return Promise.resolve().then(() => routes(url));
    }));
}

function unavailableRoute(url: string): Promise<Response> | Response {
    if (url.includes('/analysis')) {
        return errorResponse(502, 'MARKET_DATA_UNAVAILABLE', 'Market data is temporarily unavailable');
    }

    if (url.includes('/market')) {
        return errorResponse(502, 'MARKET_DATA_UNAVAILABLE', 'Market data is temporarily unavailable');
    }

    if (url.includes('/signal-history')) {
        return errorResponse(502, 'MARKET_DATA_UNAVAILABLE', 'Market data is temporarily unavailable');
    }

    return Promise.reject(new TypeError('fetch failed'));
}

async function renderMarketPage(symbol = 'BTCUSDT', searchParams: Record<string, string> = {}): Promise<string> {
    const element = await MarketPage({
        params: Promise.resolve({ symbol }),
        searchParams: Promise.resolve(searchParams),
    });

    return renderToStaticMarkup(element);
}

describe('market page 502 handling', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('keeps the page a server component and the retry button a client island', () => {
        expect(pageSource.trim().startsWith("'use client'")).toBe(false);
        expect(retrySource.trim().startsWith("'use client'")).toBe(true);
        expect(loadingSource.includes("'use client'")).toBe(false);
    });

    it('renders the unavailable state instead of throwing when the backend answers 502', async () => {
        vi.stubEnv('BACKEND_URL', unreachable());
        stubBackendFetch(unavailableRoute);

        const html = await renderMarketPage();

        expect(html).toContain('Данные рынка временно недоступны');
        expect(html).toContain('ДАННЫЕ ВРЕМЕННО НЕДОСТУПНЫ');
        expect(html).toContain('role="alert"');
        expect(html).toContain('Попробовать снова');
        expect(html).toContain('BTCUSDT');
    });

    it('renders the same state when the backend cannot be reached at all', async () => {
        vi.stubEnv('BACKEND_URL', unreachable());
        stubBackendFetch(() => Promise.reject(new TypeError('fetch failed')));

        const html = await renderMarketPage();

        expect(html).toContain('Данные рынка временно недоступны');
        expect(html).toContain('role="alert"');
    });

    it('does not render a broken half dashboard when only one request fails', async () => {
        vi.stubEnv('BACKEND_URL', unreachable());
        stubBackendFetch((url) => {
            if (new URL(url).pathname.endsWith('/analysis')) {
                return errorResponse(502, 'MARKET_DATA_UNAVAILABLE', 'Market data is temporarily unavailable');
            }

            if (url.includes('/market')) {
                return okResponse({ price: { symbol: 'BTCUSDT', price: 80000 }, candles: [], interval: '1h', instrument: null });
            }

            return Promise.reject(new TypeError('fetch failed'));
        });

        const html = await renderMarketPage();

        expect(html).toContain('Данные рынка временно недоступны');
        expect(html).not.toContain('class="hero');
    });

    it.each([
        ['analysis', 'internal'], ['market', 'internal'],
        ['analysis', 'schema'], ['market', 'schema'],
        ['analysis', 'json'], ['market', 'json'],
    ] as const)('does not mask %s %s failures behind a transient error from the other request', async (unexpectedEndpoint, failure) => {
        vi.stubEnv('BACKEND_URL', unreachable());
        stubBackendFetch((url) => {
            const path = new URL(url).pathname;
            if (path.endsWith(`/${unexpectedEndpoint}`)) {
                if (failure === 'internal') return errorResponse(500, 'INTERNAL_ERROR', 'Unexpected server error');
                if (failure === 'schema') return okResponse({ banana: true });
                return { ...okResponse({}), json: async () => { throw new SyntaxError('Invalid JSON'); } } as Response;
            }
            if (path.endsWith('/analysis') || path.endsWith('/market')) {
                return errorResponse(502, 'MARKET_DATA_UNAVAILABLE', 'Temporary outage');
            }
            return Promise.reject(new TypeError('fetch failed'));
        });
        const message = failure === 'internal' ? 'Backend returned 500: INTERNAL_ERROR'
            : failure === 'schema' ? 'Backend response does not match the contract' : 'Backend returned invalid JSON';
        await expect(renderMarketPage()).rejects.toThrow(message);
    });

    it('still throws for errors outside the transient contract', async () => {
        vi.stubEnv('BACKEND_URL', unreachable());
        stubBackendFetch((url) => {
            if (url.includes('/analysis')) {
                return errorResponse(500, 'INTERNAL_ERROR', 'Unexpected server error');
            }

            if (url.includes('/market')) {
                return errorResponse(500, 'INTERNAL_ERROR', 'Unexpected server error');
            }

            return Promise.reject(new TypeError('fetch failed'));
        });

        await expect(renderMarketPage()).rejects.toThrow('Backend returned 500: INTERNAL_ERROR');
    });

    it('names the interval on the unavailable card', async () => {
        vi.stubEnv('BACKEND_URL', unreachable());
        stubBackendFetch(unavailableRoute);

        const html = await renderMarketPage('BTCUSDT', { interval: '4h' });

        expect(html).toContain('таймфрейме 4ч');
    });
});
