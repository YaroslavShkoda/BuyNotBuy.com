import type { Migration } from './types.js';

export const migration023_instrument_series_identity: Migration = {
    version: 23,
    name: 'instrument_series_identity',
    sql: `
        -- Series identity follows the stable instrument row through a ticker
        -- rename. Legacy NULL links are excluded and retain their old indexes.
        CREATE UNIQUE INDEX IF NOT EXISTS market_candles_instrument_bar_unique
            ON market_candles (instrument_id, provider, interval, timestamp);
        CREATE UNIQUE INDEX IF NOT EXISTS signal_history_instrument_bucket_unique
            ON signal_history (instrument_id, provider, interval, hour_bucket);
        CREATE UNIQUE INDEX IF NOT EXISTS signal_outcome_instrument_horizon_unique
            ON signal_outcome (
                instrument_id, provider, interval, signal_state_id, horizon_bars
            );
        CREATE UNIQUE INDEX IF NOT EXISTS signal_snapshot_instrument_hash_unique
            ON signal_snapshot (instrument_id, input_hash);
    `,
};
