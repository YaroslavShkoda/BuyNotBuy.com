import { ApplicationError } from '../errors/application.error.js';
import type { MarketDataProvider, ProviderCandles } from '../market/providers/market-data.provider.js';
import { currentRegistry } from '../observability/registry.js';
import { CANDLE_INTERVAL_MS } from '../types/candle-interval.js';
import type { CandleSeriesKey } from './candle.repository.js';

type Operation = 'ingestion' | 'backfill';
function reject(reason: string, detail: string, operation: Operation): never {
    currentRegistry().counter('provider_errors_total', 1, { operation, reason });
    throw new ApplicationError(`${reason}: ${detail}`, { code: 'VALIDATION_ERROR', statusCode: 500 });
}

export function assertHistoricalProvider(provider: MarketDataProvider, key: CandleSeriesKey, operation: Operation): void {
    if (provider.symbol !== key.symbol) reject('symbol_mismatch', `Provider ${provider.name} serves ${provider.symbol}, which is not the series ${key.symbol}`, operation);
    if (provider.name !== 'failover' && provider.name !== key.provider) reject('venue_mismatch', `Provider ${provider.name} cannot write ${key.provider}:${key.symbol}:${key.interval}`, operation);
}

export function assertHistoricalInterval(key: CandleSeriesKey, intervalMs: number, operation: Operation): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs !== CANDLE_INTERVAL_MS[key.interval]) reject('interval_mismatch', `Duration ${intervalMs} does not match ${key.interval}`, operation);
}

export async function fetchHistoricalForSeries(provider: MarketDataProvider, key: CandleSeriesKey, operation: Operation, limit: number, before?: number, at: number = Date.now()): Promise<ProviderCandles> {
    assertHistoricalProvider(provider, key, operation);
    if (!provider.getAttributedHistoricalCandles) {
        reject('provenance_unavailable', 'Provider cannot attribute historical responses', operation);
    }
    const response = await provider.getAttributedHistoricalCandles(limit, before);
    if (response.venue !== key.provider) reject('venue_mismatch', `Expected ${key.provider}, received ${response.venue}`, operation);
    if (response.symbol !== key.symbol) reject('symbol_mismatch', `Expected ${key.symbol}, received ${response.symbol}`, operation);
    if (response.interval !== key.interval) reject('interval_mismatch', `Expected ${key.interval}, received ${response.interval}`, operation);
    const step = CANDLE_INTERVAL_MS[key.interval];
    assertHistoricalInterval(key, step, operation);
    if (!Number.isSafeInteger(at) || at < 0) reject('timestamp_invalid', 'Invalid ingestion clock', operation);
    // Validate the whole page before either writer sees its first bar.
    for (const candle of response.candles) {
        if (!Number.isSafeInteger(candle.timestamp) || candle.timestamp < 0 || candle.timestamp % step !== 0 || candle.timestamp > at) {
            reject('timestamp_invalid', `Invalid opening timestamp ${candle.timestamp} for ${key.interval}`, operation);
        }
        if (operation === 'backfill' && candle.timestamp + step > at) reject('candle_not_closed', `Backfill candle ${candle.timestamp} has not closed`, operation);
    }
    return response;
}
