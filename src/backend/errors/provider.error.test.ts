import { describe, expect, it } from 'vitest';
import { MarketDataError } from './market-data.error.js';
import type { ProviderFailureKind } from './provider.error.js';
import {
    isSelfInflicted,
    ProviderError,
    statusForKind,
} from './provider.error.js';

const KINDS: ProviderFailureKind[] = [
    'unavailable',
    'timeout',
    'rate_limited',
    'invalid_response',
    'circuit_open',
    'insufficient_history',
];

function build(
    kind: ProviderFailureKind,
    overrides: Partial<ConstructorParameters<typeof ProviderError>[2]> = {},
) {
    return new ProviderError(kind, 'test failure', {
        context: { provider: 'binance', endpoint: '/klines' },
        ...overrides,
    });
}

describe('ProviderError', () => {
    it('carries every machine-readable fact as a field', () => {
        const error = build('rate_limited', {
            context: {
                provider: 'bitget',
                endpoint: '/api/v2/spot/market/candles',
                httpStatus: 429,
                retryAfterMs: 30_000,
            },
            retryAfterSeconds: 30,
        });

        // The roadmap's requirement, and the reason this is a class: none of
        // these can be had by reading the message, which is the only thing the
        // previous shape offered.
        expect(error.kind).toBe('rate_limited');
        expect(error.provider).toBe('bitget');
        expect(error.endpoint).toBe('/api/v2/spot/market/candles');
        expect(error.httpStatus).toBe(429);
        expect(error.retryAfterMs).toBe(30_000);
        expect(error.retryAfterSeconds).toBe(30);
        expect(error.occurredAt).toBeGreaterThan(0);
    });

    it('is a MarketDataError, so the error handler needs no new branch', () => {
        expect(build('timeout')).toBeInstanceOf(MarketDataError);
    });

    it('gives each kind the code clients already receive for it', () => {
        // Not "every kind is distinct": `unavailable` and `circuit_open` are
        // different incidents with the same client-visible answer, and forcing
        // them apart would change a published contract for no benefit. What has
        // to be distinct is anything a caller *branches* on.
        expect(build('timeout').code).toBe('MARKET_PROVIDER_TIMEOUT');
        expect(build('rate_limited').code).toBe('MARKET_RATE_LIMITED');
        expect(build('insufficient_history').code).toBe('MARKET_INSUFFICIENT_HISTORY');
        expect(build('invalid_response').code).toBe('MARKET_PROVIDER_ERROR');
        expect(build('unavailable').code).toBe('MARKET_DATA_UNAVAILABLE');
        expect(build('circuit_open').code).toBe('MARKET_DATA_UNAVAILABLE');
        expect(build('unavailable', { code: 'MARKET_PROVIDER_ERROR' }).code).toBe(
            'MARKET_PROVIDER_ERROR',
        );
    });

    it('keeps the kind distinct even where the code is not', () => {
        // The failure to distinguish is the one the new shape exists to prevent:
        // `unavailable` and `circuit_open` share a code because clients cannot
        // usefully separate them, but every layer inside this application has
        // to be able to.
        const codes = KINDS.map((kind) => build(kind).code);

        expect(new Set(codes).size).toBeLessThan(KINDS.length);
        expect(new Set(KINDS).size).toBe(KINDS.length);
    });

    it('maps each kind to the status a client should see', () => {
        expect(statusForKind('timeout')).toBe(504);
        expect(statusForKind('rate_limited')).toBe(503);
        expect(statusForKind('insufficient_history')).toBe(503);
        expect(statusForKind('unavailable')).toBe(502);
        expect(statusForKind('invalid_response')).toBe(502);
        expect(statusForKind('circuit_open')).toBe(502);
    });

    it('says which failures are worth retrying, and which are not', () => {
        // The distinction that used to be made by reading English. A malformed
        // body retried is the same malformed body; a rate limit retried is an
        // offence, and the venue can ban the caller for it.
        expect(build('unavailable').retryable).toBe(true);
        expect(build('timeout').retryable).toBe(true);
        expect(build('rate_limited').retryable).toBe(false);
        expect(build('invalid_response').retryable).toBe(false);
        expect(build('circuit_open').retryable).toBe(false);
        expect(build('insufficient_history').retryable).toBe(false);
    });

    it('marks only a breaker refusal as this process\'s own doing', () => {
        // The distinction a health model needs: a breaker that opened on three
        // timeouts has learned that a venue is slow, not that it is gone, and
        // treating our own policy as evidence against the venue is how a
        // healthy backup gets taken off the roster.
        expect(isSelfInflicted(build('circuit_open'))).toBe(true);
        expect(isSelfInflicted(build('timeout'))).toBe(false);
        expect(isSelfInflicted(build('unavailable'))).toBe(false);
        expect(isSelfInflicted(new MarketDataError('plain'))).toBe(false);
        expect(isSelfInflicted(new TypeError('fetch failed'))).toBe(false);
    });

    it('leaves an absent optional field absent rather than null', () => {
        const error = build('unavailable');

        expect(error.httpStatus).toBeUndefined();
        expect(error.retryAfterMs).toBeUndefined();
        expect(error.requestId).toBeUndefined();
    });

    it('carries the request id when there is one', () => {
        // On the error rather than only in the log, so the line that reports a
        // failure and the log entry that explains it can be joined without a
        // timestamp comparison.
        const error = build('timeout', { requestId: 'req-42' });

        expect(error.requestId).toBe('req-42');
    });

    it('keeps the original error as the cause and the loggable facts as details', () => {
        const original = new TypeError('fetch failed');
        const error = build('unavailable', {
            cause: original,
            context: {
                provider: 'binance',
                endpoint: '/klines',
                details: { usedWeight: '1200' },
            },
        });

        // Two different things for two different readers. `cause` is an opaque
        // object a redaction pass must treat as unknown; `details` is what was
        // cleared for a log line. Collapsing them is what made the only way to
        // read a weight reading a dig through the cause.
        expect(error.cause).toBe(original);
        expect(error.details).toEqual({ usedWeight: '1200' });
    });

    it('has empty details rather than undefined when there are none', () => {
        expect(build('timeout').details).toEqual({});
    });

    it('lets a caller override the code the kind implies', () => {
        expect(build('unavailable', { code: 'MARKET_PROVIDER_ERROR' }).code).toBe(
            'MARKET_PROVIDER_ERROR',
        );
    });
});
