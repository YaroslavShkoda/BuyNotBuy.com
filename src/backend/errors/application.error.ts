export type ErrorCode =
    | 'MARKET_DATA_UNAVAILABLE'
    | 'MARKET_PROVIDER_ERROR'
    | 'MARKET_PROVIDER_TIMEOUT'
    | 'MARKET_RATE_LIMITED'
    | 'RATE_LIMITED'
    | 'MARKET_INSUFFICIENT_HISTORY'
    | 'VALIDATION_ERROR'
    | 'INVALID_REQUEST'
    | 'NOT_FOUND'
    | 'INTERNAL_ERROR';

export interface ApplicationErrorOptions {
    code: ErrorCode;
    statusCode: number;
    cause?: unknown;
    /** Tells the client when it is worth asking again, in whole seconds. */
    retryAfterSeconds?: number;
}

export class ApplicationError extends Error {
    readonly code: ErrorCode;
    readonly statusCode: number;
    readonly retryAfterSeconds: number | undefined;

    constructor(message: string, options: ApplicationErrorOptions) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);

        this.name = 'ApplicationError';
        this.code = options.code;
        this.statusCode = options.statusCode;
        this.retryAfterSeconds = options.retryAfterSeconds;
    }
}
