import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { marketConfig } from '../../config/market.config.js';
import { MarketDataError } from '../../errors/market-data.error.js';

import {
    backoffDelayMs,
    parseRetryAfterMs,
    resetBinanceTransport,
    sendBinanceRequest,
} from './binance-http.js';

const ENDPOINT = '/api/v3/klines';
const URL = 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT';

function okResponse() {
    return {
        ok: true,
        status: 200,
        headers: new Headers(),
    };
}

function statusResponse(status: number, headers: HeadersInit = {}) {
    return {
        ok: false,
        status,
        headers: new Headers(headers),
    };
}

/**
 * Lets queued microtasks and any pending backoff timers run.
 *
 * The window is one backoff cap: long enough to drain every retry of a
 * request, and deliberately far shorter than the breaker cooldown so a test
 * cannot accidentally outrun the circuit it is asserting on.
 */
async function settle() {
    await vi.advanceTimersByTimeAsync(marketConfig.retryMaxDelayMs);
}

/**
 * Runs a request to completion and returns whatever it settled with.
 *
 * The rejection handler is attached before the clock is advanced: a request
 * that fails mid-retry would otherwise be reported as an unhandled rejection
 * while the test is still inside `settle()`.
 */
async function runToCompletion(signal?: AbortSignal): Promise<unknown> {
    const outcome = sendBinanceRequest({
        url: URL,
        endpoint: ENDPOINT,
        ...(signal === undefined ? {} : { signal }),
    }).catch((error: unknown) => error);

    await settle();

    return outcome;
}

beforeEach(() => {
    resetBinanceTransport();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('parseRetryAfterMs', () => {
    it('reads the delta-seconds form', () => {
        expect(parseRetryAfterMs('30')).toBe(30_000);
    });

    it('reads a zero', () => {
        expect(parseRetryAfterMs('0')).toBe(0);
    });

    it('reads an HTTP-date form relative to now', () => {
        const future = new Date(Date.now() + 45_000).toUTCString();

        expect(parseRetryAfterMs(future)).toBeGreaterThan(40_000);
    });

    it('never returns a negative wait for a past date', () => {
        const past = new Date(Date.now() - 45_000).toUTCString();

        expect(parseRetryAfterMs(past)).toBe(0);
    });

    it('returns null for a missing or unparseable header', () => {
        expect(parseRetryAfterMs(null)).toBeNull();
        expect(parseRetryAfterMs('   ')).toBeNull();
        expect(parseRetryAfterMs('soon')).toBeNull();
    });
});

describe('backoffDelayMs', () => {
    it('never exceeds the configured cap and grows with the attempt', () => {
        const first = Array.from({ length: 50 }, () => backoffDelayMs(0));
        const later = Array.from({ length: 50 }, () => backoffDelayMs(4));

        for (const value of first) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(
                marketConfig.retryBaseDelayMs,
            );
        }

        for (const value of later) {
            expect(value).toBeLessThanOrEqual(marketConfig.retryMaxDelayMs);
        }

        const firstMax = Math.max(...first);
        const laterMax = Math.max(...later);

        expect(laterMax).toBeGreaterThan(firstMax);
    });

    it('uses full jitter so simultaneous failures do not retry in lockstep', () => {
        const values = new Set(
            Array.from({ length: 30 }, () => backoffDelayMs(3)),
        );

        // A fixed schedule would make every client that failed together retry
        // together, which is the herd the backoff exists to break up.
        expect(values.size).toBeGreaterThan(1);
    });
});

describe('sendBinanceRequest retries', () => {
    it('returns a successful response without retrying', async () => {
        const fetchMock = vi.fn().mockResolvedValue(okResponse());
        vi.stubGlobal('fetch', fetchMock);

        const response = await sendBinanceRequest({ url: URL, endpoint: ENDPOINT });

        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a 5xx and succeeds on a later attempt', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(statusResponse(503))
            .mockResolvedValueOnce(okResponse());
        vi.stubGlobal('fetch', fetchMock);

        const promise = sendBinanceRequest({ url: URL, endpoint: ENDPOINT });
        await settle();
        const response = await promise;

        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a dropped connection and succeeds on a later attempt', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(okResponse());
        vi.stubGlobal('fetch', fetchMock);

        const promise = sendBinanceRequest({ url: URL, endpoint: ENDPOINT });
        await settle();
        const response = await promise;

        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up after the configured number of retries', async () => {
        const fetchMock = vi.fn().mockResolvedValue(statusResponse(500));
        vi.stubGlobal('fetch', fetchMock);

        const promise = sendBinanceRequest({ url: URL, endpoint: ENDPOINT });
        await settle();

        await expect(promise).resolves.toMatchObject({ status: 500 });
        expect(fetchMock).toHaveBeenCalledTimes(marketConfig.maxRetries + 1);
    });

    it('does not retry a 4xx: the provider already decided', async () => {
        const fetchMock = vi.fn().mockResolvedValue(statusResponse(400));
        vi.stubGlobal('fetch', fetchMock);

        const response = await sendBinanceRequest({ url: URL, endpoint: ENDPOINT });

        expect(response.status).toBe(400);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('identifies itself with a User-Agent on every attempt', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(statusResponse(500))
            .mockResolvedValueOnce(okResponse());
        vi.stubGlobal('fetch', fetchMock);

        const promise = sendBinanceRequest({ url: URL, endpoint: ENDPOINT });
        await settle();
        await promise;

        expect(fetchMock).toHaveBeenCalledTimes(2);

        for (const call of fetchMock.mock.calls) {
            // Binance blocks unidentified clients, so every attempt has to
            // carry the same identity.
            expect(call[1]).toMatchObject({
                headers: {
                    'User-Agent': marketConfig.userAgent,
                },
            });
        }
    });
});

describe('sendBinanceRequest circuit breaker', () => {
    it('stops calling the provider after repeated failures', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
        vi.stubGlobal('fetch', fetchMock);

        let refused = false;

        for (let index = 0; index < 10 && !refused; index += 1) {
            const outcome = await runToCompletion();

            refused = (outcome as MarketDataError).cause !== undefined;
        }

        expect(refused).toBe(true);

        const callsWhenOpen = fetchMock.mock.calls.length;

        // While open, the refusal is immediate and no socket is opened at all.
        expect(await runToCompletion()).toMatchObject({
            code: 'MARKET_DATA_UNAVAILABLE',
        });

        expect(fetchMock).toHaveBeenCalledTimes(callsWhenOpen);
    });

    it('reports how long the caller should wait while open', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

        for (let index = 0; index < 10; index += 1) {
            const outcome = await runToCompletion();

            if ((outcome as MarketDataError).cause !== undefined) {
                break;
            }
        }

        const error = await runToCompletion();

        expect(error).toBeInstanceOf(MarketDataError);
        expect((error as MarketDataError).cause).toMatchObject({
            circuit: 'open',
        });
        expect((error as MarketDataError).retryAfterSeconds).toBeGreaterThan(0);
    });

    it('reopens only after the cooldown has elapsed', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
        vi.stubGlobal('fetch', fetchMock);

        for (let index = 0; index < 10; index += 1) {
            const outcome = await runToCompletion();

            if ((outcome as MarketDataError).cause !== undefined) {
                break;
            }
        }

        await vi.advanceTimersByTimeAsync(
            marketConfig.circuitCooldownMs + 1,
        );

        // Exactly one probe is admitted after the cooldown.
        await runToCompletion();

        const callsAfterCooldown = fetchMock.mock.calls.length;
        expect(callsAfterCooldown).toBeGreaterThan(0);

        expect(await runToCompletion()).toMatchObject({
            code: 'MARKET_DATA_UNAVAILABLE',
        });

        expect(fetchMock.mock.calls.length).toBe(callsAfterCooldown);
    });
});

describe('sendBinanceRequest rate limiting', () => {
    it('opens the circuit for the window the provider asked for', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            statusResponse(429, { 'Retry-After': '42' }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const error = await sendBinanceRequest({
            url: URL,
            endpoint: ENDPOINT,
        }).catch((e: unknown) => e);

        expect((error as MarketDataError).code).toBe('MARKET_RATE_LIMITED');
        expect((error as MarketDataError).retryAfterSeconds).toBe(42);

        // The next call is refused without a socket until the window closes.
        await vi.advanceTimersByTimeAsync(42_000 + 1);

        await runToCompletion();

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to the configured cooldown when no hint is given', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(statusResponse(429)));

        const error = await sendBinanceRequest({
            url: URL,
            endpoint: ENDPOINT,
        }).catch((e: unknown) => e);

        expect((error as MarketDataError).retryAfterSeconds).toBe(
            Math.round(marketConfig.circuitCooldownMs / 1000),
        );
    });
});

describe('sendBinanceRequest cancellation', () => {
    it('combines the caller signal with the per-attempt timeout', async () => {
        const anySpy = vi.spyOn(AbortSignal, 'any');
        const fetchMock = vi.fn().mockResolvedValue(okResponse());
        vi.stubGlobal('fetch', fetchMock);

        const controller = new AbortController();

        await sendBinanceRequest({
            url: URL,
            endpoint: ENDPOINT,
            signal: controller.signal,
        });

        // Without the combination, adding a caller deadline would silently
        // replace the transport's own timeout.
        expect(anySpy).toHaveBeenCalledTimes(1);
        expect(anySpy.mock.calls[0]?.[0]).toHaveLength(2);
    });

    it('stops retrying when the caller gives up', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
        vi.stubGlobal('fetch', fetchMock);

        const controller = new AbortController();
        const outcome = runToCompletion(controller.signal);

        controller.abort();

        expect(await outcome).toBeInstanceOf(TypeError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
