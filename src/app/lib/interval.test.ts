import { describe, expect, it } from 'vitest';

import { SUPPORTED_CANDLE_INTERVALS } from '../../backend/types/candle-interval';
import { BackendApiError } from './api-error';
import {
    candleStepLabel,
    DEFAULT_INTERVAL,
    intervalHref,
    intervalLabel,
    isInsufficientHistoryError,
    normalizeInterval,
} from './interval';

describe('normalizeInterval', () => {
    it('accepts exactly the intervals the backend supports', () => {
        expect(normalizeInterval('15m')).toBe('15m');
        expect(normalizeInterval('1h')).toBe('1h');
        expect(normalizeInterval('4h')).toBe('4h');
        expect(normalizeInterval('1d')).toBe('1d');
        expect(SUPPORTED_CANDLE_INTERVALS).toHaveLength(4);
    });

    it('falls back to the default for unknown, missing and non-string values', () => {
        expect(DEFAULT_INTERVAL).toBe('1h');
        expect(normalizeInterval('5m')).toBe('1h');
        expect(normalizeInterval('')).toBe('1h');
        expect(normalizeInterval(undefined)).toBe('1h');
        expect(normalizeInterval(null)).toBe('1h');
        expect(normalizeInterval(42)).toBe('1h');
    });

    it('reads the first value when searchParams repeats the key', () => {
        expect(normalizeInterval(['1d', '15m'])).toBe('1d');
        expect(normalizeInterval(['nonsense', '1d'])).toBe('1h');
    });
});

describe('intervalHref', () => {
    it('encodes the symbol and names the interval as a query parameter', () => {
        expect(intervalHref('BTCUSDT', '4h')).toBe('/market/BTCUSDT?interval=4h');
        expect(intervalHref('../other', '1d')).toBe('/market/..%2Fother?interval=1d');
    });

    it('defaults to the default interval', () => {
        expect(intervalHref('BTCUSDT')).toBe('/market/BTCUSDT?interval=1h');
    });
});

describe('labels', () => {
    it('names every supported interval for the switcher and the captions', () => {
        expect(intervalLabel('15m')).toBe('15м');
        expect(intervalLabel('1h')).toBe('1ч');
        expect(intervalLabel('4h')).toBe('4ч');
        expect(intervalLabel('1d')).toBe('1д');

        expect(candleStepLabel('15m')).toBe('15 минут');
        expect(candleStepLabel('1h')).toBe('час');
        expect(candleStepLabel('4h')).toBe('4 часа');
        expect(candleStepLabel('1d')).toBe('сутки');
    });
});

describe('isInsufficientHistoryError', () => {
    const insufficient = {
        error: { code: 'MARKET_INSUFFICIENT_HISTORY', message: 'x' },
    };

    it('recognizes only the 503 MARKET_INSUFFICIENT_HISTORY pair', () => {
        expect(isInsufficientHistoryError(new BackendApiError(503, insufficient))).toBe(true);
    });

    it('rejects the same code on another status and another code on 503', () => {
        expect(isInsufficientHistoryError(new BackendApiError(502, insufficient))).toBe(false);
        expect(isInsufficientHistoryError(new BackendApiError(504, insufficient))).toBe(false);
        expect(isInsufficientHistoryError(new BackendApiError(503, {
            error: { code: 'MARKET_DATA_UNAVAILABLE', message: 'x' },
        }))).toBe(false);
    });

    it('rejects errors that are not BackendApiError', () => {
        expect(isInsufficientHistoryError(new Error('Backend returned 503'))).toBe(false);
        expect(isInsufficientHistoryError(null)).toBe(false);
        expect(isInsufficientHistoryError(undefined)).toBe(false);
    });
});
