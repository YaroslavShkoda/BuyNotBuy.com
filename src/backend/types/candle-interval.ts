/**
 * The candle intervals this application computes, and their durations.
 *
 * Lives in `types/` for the same reason `venue.ts` does: the configuration
 * layer, the API validators and the market layer all need the same vocabulary,
 * `config` cannot import `market`, and a word that three layers say must have
 * one declaration. The list is deliberately closed. An interval is not a free
 * string the venues happen to accept — every interval must be one the whole
 * pipeline can reason about: the warm-up needs a bar duration to tell a hole
 * from a stall, the votes need one to bucket settlement, and the storage layer
 * keys every series on it. A fourth string accepted here would be a series
 * nobody can validate downstream.
 */
export const SUPPORTED_CANDLE_INTERVALS = ['15m', '1h', '4h', '1d'] as const;

export type CandleInterval = (typeof SUPPORTED_CANDLE_INTERVALS)[number];

/** The length of one bar, per interval. Total, so a lookup cannot return undefined. */
export const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
    '15m': 900_000,
    '1h': 3_600_000,
    '4h': 14_400_000,
    '1d': 86_400_000,
};
