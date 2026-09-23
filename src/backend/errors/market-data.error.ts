import { ApplicationError } from './application.error';

import type { ErrorCode } from './application.error';

interface MarketDataErrorOptions {
    code?: ErrorCode;
    statusCode?: number;
    cause?: unknown;
}

function statusCodeFor(code: ErrorCode): number {
    switch (code) {
        case 'MARKET_PROVIDER_TIMEOUT':
            return 504;

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
        });

        this.name = 'MarketDataError';
    }
}
