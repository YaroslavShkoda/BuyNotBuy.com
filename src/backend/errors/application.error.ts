export type ErrorCode =
    | 'MARKET_DATA_UNAVAILABLE'
    | 'MARKET_PROVIDER_ERROR'
    | 'MARKET_PROVIDER_TIMEOUT'
    | 'VALIDATION_ERROR'
    | 'INTERNAL_ERROR';

export interface ApplicationErrorOptions {
    code: ErrorCode;
    statusCode: number;
    cause?: unknown;
}

export class ApplicationError extends Error {
    readonly code: ErrorCode;
    readonly statusCode: number;

    constructor(message: string, options: ApplicationErrorOptions) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);

        this.name = 'ApplicationError';
        this.code = options.code;
        this.statusCode = options.statusCode;
    }
}
