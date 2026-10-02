import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { marketConfig } from '../../config/market.config.js';

import { CircuitBreaker } from './circuit-breaker.js';
import {
    isVenueAvailable,
    providerCircuitState,
    resetProviderTransport,
    sendProviderRequest,
} from './provider-http.js';

/**
 * The breaker's job is to stop the application hammering an upstream that has
 * already said no, and the only place that can go wrong is a burst. A single
 * caller failing four times is a testable sequence; a hundred callers finding
 * the breaker closed in the same tick is a different property entirely, and it
 * is the one that decides whether the breaker does any work at all.
 *
 * The reservation is what makes that property hold, so the tests here are
 * written against the reservation's lifetime: who releases it, and what happens
 * when a holder never comes back.
 */

const ENDPOINT = '/api/v3/klines';
const URL = 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT';

/**
 * Drives one venue to an open breaker.
 *
 * Uses the real transport rather than poking a breaker directly, because the
 * question is what the running application ends up with — and a breaker that
 * was opened by the wrong sequence of calls is open for reasons the next test
 * would then inherit.
 */
async function openTheBreaker(): Promise<void> {
    for (let index = 0; index < marketConfig.circuitFailureThreshold; index += 1) {
        const attempt = sendProviderRequest({
            provider: 'binance',
            market: 'BTCUSDT',
            url: URL,
            endpoint: ENDPOINT,
        }).catch(() => undefined);

        // The request retries with a backoff under a clock this suite controls,
        // so the clock has to move while the promise is pending. Awaiting the
        // promise first would wait forever for a timer nobody advances.
        await vi.advanceTimersByTimeAsync(marketConfig.retryMaxDelayMs);
        await attempt;
    }
}

/** Elapses the cooldown, after which the breaker admits exactly one probe. */
async function elapseCooldown(): Promise<void> {
    await vi.advanceTimersByTimeAsync(marketConfig.circuitCooldownMs + 1);
}

beforeEach(() => {
    resetProviderTransport('binance');
    resetProviderTransport('bitget');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('CircuitBreaker probe reservation', () => {
    it('admits exactly one probe when a burst finds the cooldown elapsed', () => {
        const breaker = new CircuitBreaker({
            failureThreshold: 2,
            cooldownMs: 1_000,
        });

        breaker.recordFailure();
        breaker.recordFailure();

        expect(breaker.state).toBe('open');

        vi.advanceTimersByTime(1_001);

        expect(breaker.state).toBe('probing');

        // The whole point. If this were "ask and then set", every one of these
        // would be true and a hundred callers would hit a venue that just said
        // no, which is how a short outage becomes a rate-limit ban.
        const admitted = Array.from({ length: 100 }, () => breaker.tryAcquire());

        expect(admitted.filter(Boolean)).toHaveLength(1);
    });

    it('holds the reservation until the probe reports back', () => {
        const breaker = new CircuitBreaker({
            failureThreshold: 1,
            cooldownMs: 1_000,
        });

        breaker.recordFailure();
        vi.advanceTimersByTime(1_001);

        expect(breaker.tryAcquire()).toBe(true);
        // The probe is still in flight: everyone else is refused, which is the
        // behaviour, and also why the reservation has to be released by the
        // probe's own outcome rather than by a timer.
        expect(breaker.tryAcquire()).toBe(false);
        expect(breaker.tryAcquire()).toBe(false);
    });

    it('closes on a probe that succeeds, and admits traffic again', () => {
        const breaker = new CircuitBreaker({
            failureThreshold: 1,
            cooldownMs: 1_000,
        });

        breaker.recordFailure();
        vi.advanceTimersByTime(1_001);
        breaker.tryAcquire();
        breaker.recordSuccess();

        expect(breaker.state).toBe('closed');
        expect(Array.from({ length: 50 }, () => breaker.tryAcquire()).every(Boolean))
            .toBe(true);
    });

    it('restarts the cooldown when the probe fails', () => {
        const breaker = new CircuitBreaker({
            failureThreshold: 1,
            cooldownMs: 1_000,
        });

        breaker.recordFailure();
        vi.advanceTimersByTime(1_001);
        breaker.tryAcquire();
        breaker.recordFailure();

        // Not immediately probing again. A probe that failed means the venue is
        // still unwell, and re-probing in a tight loop is the outage it was
        // meant to survive.
        expect(breaker.state).toBe('open');
        expect(breaker.tryAcquire()).toBe(false);

        vi.advanceTimersByTime(1_001);

        expect(breaker.state).toBe('probing');
    });

    it('lets a later probe through after a rate limit arrived on the probe', () => {
        // This is the strand described in `openFor`, reproduced here as its own
        // property: the probe got a definitive answer, the reservation has to be
        // released, and the venue must not stay silent for the life of the
        // process after a window that has already expired.
        const breaker = new CircuitBreaker({
            failureThreshold: 1,
            cooldownMs: 1_000,
        });

        breaker.recordFailure();
        vi.advanceTimersByTime(1_001);
        breaker.tryAcquire();
        breaker.openFor(500);

        expect(breaker.state).toBe('open');

        vi.advanceTimersByTime(501);

        expect(breaker.state).toBe('probing');
        expect(breaker.tryAcquire()).toBe(true);
    });

    it('releases the reservation when a probe never gets to report', () => {
        // The holder is a caller that gave up — a shutdown, a client that
        // navigated away. Nothing in the venue's control will ever release the
        // reservation, and the venue would be silent for the life of the
        // process. This is the case that has no natural timer to save it.
        const breaker = new CircuitBreaker({
            failureThreshold: 1,
            cooldownMs: 1_000,
        });

        breaker.recordFailure();
        vi.advanceTimersByTime(1_001);

        expect(breaker.tryAcquire()).toBe(true);

        breaker.releaseProbe();

        expect(breaker.tryAcquire()).toBe(true);
    });

    it('is harmless to release when nothing is held', () => {
        // Releasing is not ownership-checked — the reservation is one boolean,
        // and the transport only calls this on the branch where it was told yes.
        // What that buys is that a release can never make things *worse*: the
        // worst a stray release can do is hand out one probe early, which is
        // still one probe.
        const breaker = new CircuitBreaker({
            failureThreshold: 1,
            cooldownMs: 1_000,
        });

        breaker.recordFailure();

        expect(breaker.state).toBe('open');

        breaker.releaseProbe();

        expect(breaker.state).toBe('open');
        expect(breaker.tryAcquire()).toBe(false);
    });
});

describe('CircuitBreaker through the transport', () => {
    it('sends exactly one of a hundred concurrent callers after the cooldown', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
        vi.stubGlobal('fetch', fetchMock);

        await openTheBreaker();
        await elapseCooldown();

        const callsBefore = fetchMock.mock.calls.length;

        // Fired together, so every one of them reads the same state.
        const burst = Array.from({ length: 100 }, () =>
            sendProviderRequest({
                provider: 'binance',
                market: 'BTCUSDT',
                url: URL,
                endpoint: ENDPOINT,
            }).catch((error: unknown) => error),
        );

        await vi.advanceTimersByTimeAsync(marketConfig.retryMaxDelayMs);
        await Promise.all(burst);

        // One request was admitted, and it spent its own retry budget. The
        // count is the probe plus its retries rather than a bare 1, because a
        // retry is the same request talking again — a second admission would
        // add another full budget on top, and that is the number worth watching:
        // ninety-nine extra callers reaching a venue that just refused is what
        // turns a short outage into a rate-limit ban.
        expect(fetchMock.mock.calls.length - callsBefore).toBe(
            1 + marketConfig.maxRetries,
        );
    });

    it('refuses the other 99 without inventing a socket', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
        vi.stubGlobal('fetch', fetchMock);

        await openTheBreaker();
        await elapseCooldown();

        const callsBefore = fetchMock.mock.calls.length;

        const burst = Array.from({ length: 100 }, () =>
            sendProviderRequest({
                provider: 'binance',
                market: 'BTCUSDT',
                url: URL,
                endpoint: ENDPOINT,
            }).catch((error: unknown) => error),
        );

        await vi.advanceTimersByTimeAsync(marketConfig.retryMaxDelayMs);
        const outcomes = await Promise.all(burst);

        // The other ninety-nine never reached a socket at all: a refused call
        // is the breaker doing its job, and a refusal that still opened a
        // connection would be indistinguishable from a venue that simply is not
        // answering.
        expect(fetchMock.mock.calls.length - callsBefore).toBe(
            1 + marketConfig.maxRetries,
        );

        // Refused callers all get the same typed answer, and none of them is
        // told to go and try the venue again immediately.
        const refused = outcomes.filter(
            (error) => (error as { kind?: string }).kind === 'circuit_open',
        );

        expect(refused).toHaveLength(99);

        for (const error of refused) {
            expect((error as { retryable?: boolean }).retryable).toBe(false);
        }
    });

    it('does not let an abandoned probe silence the venue forever', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
        vi.stubGlobal('fetch', fetchMock);

        await openTheBreaker();
        await elapseCooldown();

        // The cooldown's single probe is taken and then abandoned by its caller.
        const controller = new AbortController();
        const abandoned = sendProviderRequest({
            provider: 'binance',
            market: 'BTCUSDT',
            url: URL,
            endpoint: ENDPOINT,
            signal: controller.signal,
        }).catch(() => undefined);

        controller.abort();
        await abandoned;

        expect(providerCircuitState('binance', 'BTCUSDT')).toBe('probing');

        // The reservation the abandoned probe was holding is gone, so the next
        // caller can take it. If it is still held, the venue is never asked
        // again until the process restarts — a healthy backup silently gone for
        // the rest of the day.
        const next = sendProviderRequest({
            provider: 'binance',
            market: 'BTCUSDT',
            url: URL,
            endpoint: ENDPOINT,
        }).catch(() => undefined);

        await vi.advanceTimersByTimeAsync(marketConfig.retryMaxDelayMs);
        await next;

        expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    });

    it('keeps one venue open without touching the other', async () => {
        const binanceMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
        const bitgetMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers(),
        });
        vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
            String(input).includes('binance') ? binanceMock() : bitgetMock(),
        );

        await openTheBreaker();

        expect(providerCircuitState('binance', 'BTCUSDT')).toBe('open');
        expect(isVenueAvailable('binance', 'BTCUSDT')).toBe(false);

        // The whole reason the breaker is per-venue. A shared breaker means the
        // first venue to go dark takes the healthy one out of rotation with it.
        expect(providerCircuitState('bitget', 'BTCUSDT')).toBe('closed');
        expect(isVenueAvailable('bitget', 'BTCUSDT')).toBe(true);

        const response = await sendProviderRequest({
            provider: 'bitget',
            market: 'BTCUSDT',
            url: 'https://api.bitget.com/api/v2/spot/market/candles',
            endpoint: '/candles',
        });

        expect(response.status).toBe(200);
    });

    it('comes back on demand', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

        await openTheBreaker();

        expect(isVenueAvailable('binance', 'BTCUSDT')).toBe(false);

        resetProviderTransport('binance');

        expect(providerCircuitState('binance', 'BTCUSDT')).toBe('closed');
        expect(isVenueAvailable('binance', 'BTCUSDT')).toBe(true);
    });

    it('reopens a recovered venue for real traffic after the reset', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
        vi.stubGlobal('fetch', fetchMock);

        await openTheBreaker();

        const refusedBefore = fetchMock.mock.calls.length;

        await sendProviderRequest({
            provider: 'binance',
            market: 'BTCUSDT',
            url: URL,
            endpoint: ENDPOINT,
        }).catch(() => undefined);

        // An open breaker costs nothing: the refusal never opens a socket.
        expect(fetchMock.mock.calls.length).toBe(refusedBefore);

        resetProviderTransport('binance');

        const reopened = sendProviderRequest({
            provider: 'binance',
            market: 'BTCUSDT',
            url: URL,
            endpoint: ENDPOINT,
        }).catch(() => undefined);

        await vi.advanceTimersByTimeAsync(marketConfig.retryMaxDelayMs);
        await reopened;

        // Which is the point of a reset: an operator who knows the venue is
        // back does not have to wait out a cooldown they did not choose.
        expect(fetchMock.mock.calls.length).toBeGreaterThan(refusedBefore);
    });
});
