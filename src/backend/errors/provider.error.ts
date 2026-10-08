import type { ErrorCode } from './application.error.js';
import type { MarketDataErrorOptions } from './market-data.error.js';
import { MarketDataError } from './market-data.error.js';

/**
 * Why a venue did not produce a price.
 *
 * The distinction the previous code could not express, and the one that decides
 * what a caller should do next. Every branch below used to arrive as the same
 * `MarketDataError` with a message, so answering "should this be retried?" or
 * "is the venue alive?" meant reading English:
 *
 * - `unavailable` — the venue would not answer. An outage; try elsewhere.
 * - `timeout` — the venue did not answer in time. An outage with a different
 *   cause, and the one that has to produce a 504 rather than a 502, because
 *   "the gateway is fine, the upstream is slow" is a different page incident.
 * - `rate_limited` — the venue is refusing on purpose, for a window it stated.
 *   Retrying is the one response that makes it worse.
 * - `invalid_response` — the venue answered and the answer was not the contract.
 *   A retry usually gets the same answer; this is a bug on one side of the wire
 *   and needs a human, not a backoff.
 * - `circuit_open` — *this process* has decided to stop asking. Nothing is
 *   wrong with the venue; the refusal is ours, and it expires.
 * - `insufficient_history` — the venue answered correctly and there is not
 *   enough history to compute anything. The only kind that is not a failure at
 *   all, and the only one a retry cannot fix.
 *
 * Each of those is a class rather than a string on purpose: a caller that
 * branches on `instanceof` cannot be broken by a message that changed, by a
 * translation, or by a venue whose wording this application has never read.
 */
export type ProviderFailureKind =
    | 'unavailable'
    | 'timeout'
    | 'rate_limited'
    | 'invalid_response'
    | 'circuit_open'
    | 'insufficient_history';

interface ProviderErrorContext {
    provider: string;
    /** Path only. Never a full URL: a query string can carry a signature. */
    endpoint?: string | undefined;
    httpStatus?: number | undefined;
    /** Remaining wait, when the venue or the breaker stated one. */
    retryAfterMs?: number | undefined;
    /** Anything else safe to log — already redacted by the caller. */
    details?: Record<string, unknown> | undefined;
}

interface ProviderErrorOptions extends MarketDataErrorOptions {
    context: ProviderErrorContext;
    /**
     * Correlation id, when the failure happened inside a request.
     *
     * Carried on the error rather than only in the log so the line that reports
     * it and the log entry that explains it can be joined without a thread-local
     * or a timestamp comparison.
     */
    requestId?: string | undefined;
}

/**
 * Every machine-readable fact about a provider failure, in one place.
 *
 * The roadmap's requirement, and the reason this is a class rather than a bag
 * of ad-hoc `cause` fields: `cause` was free-form, so the only way for a caller
 * to learn the HTTP status was to dig into an untyped object, and the only way
 * to learn the venue was to parse a message. Both are now reads.
 */
export class ProviderError extends MarketDataError {
    readonly kind: ProviderFailureKind;
    readonly provider: string;
    readonly endpoint: string | undefined;
    readonly httpStatus: number | undefined;
    readonly retryAfterMs: number | undefined;
    readonly requestId: string | undefined;
    /**
     * Venue-specific extras, already reduced to strings and numbers.
     *
     * Kept separate from `cause` on purpose. `cause` is the original error
     * object, which no caller can safely read and which a redaction pass must
     * treat as unknown; this is the part that was cleared for logging and is
     * safe to put in a line. Mixing the two is what made "read the weight
     * header out of the cause" the only way to get a weight reading at all.
     */
    readonly details: Readonly<Record<string, unknown>>;
    /** When the failure happened, in epoch milliseconds. */
    readonly occurredAt: number;

    constructor(
        kind: ProviderFailureKind,
        message: string,
        options: ProviderErrorOptions,
    ) {
        const { context, requestId, ...rest } = options;

        super(message, {
            ...rest,
            code: options.code ?? codeForKind(kind),
        });

        this.name = 'ProviderError';
        this.kind = kind;
        this.provider = context.provider;
        this.endpoint = context.endpoint;
        this.httpStatus = context.httpStatus;
        this.retryAfterMs = context.retryAfterMs;
        this.requestId = requestId;
        this.details = context.details ?? {};
        this.occurredAt = Date.now();
    }

    /** Whether asking the same venue again can plausibly work. */
    get retryable(): boolean {
        return this.kind === 'unavailable' || this.kind === 'timeout';
    }
}

function codeForKind(kind: ProviderFailureKind): ErrorCode {
    switch (kind) {
        case 'timeout':
            return 'MARKET_PROVIDER_TIMEOUT';

        case 'rate_limited':
            return 'MARKET_RATE_LIMITED';

        case 'insufficient_history':
            return 'MARKET_INSUFFICIENT_HISTORY';

        // `MARKET_PROVIDER_ERROR` rather than `MARKET_DATA_UNAVAILABLE` on
        // purpose, and not to preserve a string for its own sake: that code is
        // the one clients already receive for "the venue answered and the
        // answer was not the contract". The unreachable venue has its own code.
        // The distinction the client can act on — it will not fix itself by
        // waiting — is the same one that always existed.
        case 'invalid_response':
            return 'MARKET_PROVIDER_ERROR';

        case 'unavailable':
        case 'circuit_open':
            return 'MARKET_DATA_UNAVAILABLE';
    }
}

/** The status this failure should surface to an HTTP client. */
export function statusForKind(kind: ProviderFailureKind): number {
    switch (kind) {
        case 'timeout':
            return 504;

        case 'rate_limited':
        case 'insufficient_history':
            return 503;

        case 'invalid_response':
        case 'unavailable':
        case 'circuit_open':
            return 502;
    }
}

/**
 * Whether a failure is this application's own doing rather than the venue's.
 *
 * A `circuit_open` is a refusal *we* issued, and the distinction is what stops
 * a health model from marking a perfectly healthy venue as broken: a breaker
 * that opened on three timeouts has learned that the venue is slow, not that it
 * is gone.
 */
export function isSelfInflicted(error: unknown): boolean {
    return error instanceof ProviderError && error.kind === 'circuit_open';
}
