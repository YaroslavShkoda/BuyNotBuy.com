import { ApplicationError } from './application.error.js';

import type { ErrorCode } from './application.error.js';

interface MarketDataErrorOptions {
    code?: ErrorCode;
    statusCode?: number;
    cause?: unknown;
    retryAfterSeconds?: number;
}

function statusCodeFor(code: ErrorCode): number {
    switch (code) {
        case 'MARKET_PROVIDER_TIMEOUT':
            return 504;

        case 'MARKET_INSUFFICIENT_HISTORY':
        case 'MARKET_RATE_LIMITED':
            return 503;

        case 'MARKET_DATA_UNAVAILABLE':
        case 'MARKET_PROVIDER_ERROR':
            return 502;

        default:
            return 500;
    }
}

export class MarketDataError extends ApplicationError {
    constructor(message: string, options: MarketDataErrorOptions = {}) {
        const code = options.code ?? 'MARKET_DATA_UNAVAILABLE';

        super(message, {
            code,
            statusCode: options.statusCode ?? statusCodeFor(code),
            cause: options.cause,
            ...(options.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: options.retryAfterSeconds }),
        });

        this.name = 'MarketDataError';
    }
}
