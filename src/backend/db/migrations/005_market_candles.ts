import type { Migration } from './types.js';

export const migration005_market_candles: Migration = {
        version: 5,
        name: 'market_candles',
        sql: `
            CREATE TABLE IF NOT EXISTS market_candles (
                id BIGSERIAL PRIMARY KEY,
                provider TEXT NOT NULL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                timestamp BIGINT NOT NULL,
                open DOUBLE PRECISION NOT NULL,
                high DOUBLE PRECISION NOT NULL,
                low DOUBLE PRECISION NOT NULL,
                close DOUBLE PRECISION NOT NULL,
                volume DOUBLE PRECISION NOT NULL,
                ingested_at BIGINT NOT NULL,

                -- A candle that is still forming is a different record from the
                -- same candle once it has closed, and storing it as one row
                -- would mean the last bar of every hour is a moving target: the
                -- value read now and the value read an hour later would occupy
                -- the same row, and any backtest run over this table would
                -- silently disagree with itself depending on when it ran.
                --
                -- The primary key is the identity of the bar; this says whether
                -- what is stored is final. A closed bar is the only kind a
                -- backtest is allowed to read.
                is_closed BOOLEAN NOT NULL DEFAULT TRUE,

                CONSTRAINT market_candles_ohlc_sane CHECK (
                    high >= low
                    AND high >= open
                    AND high >= close
                    AND low <= open
                    AND low <= close
                    AND open > 0
                    AND high > 0
                    AND low > 0
                    AND close > 0
                    AND volume >= 0
                ),

                -- The venue is part of the identity, not a column that happens
                -- to be there. Binance and Bitget print different numbers for
                -- the same hour, and a table keyed only by time would keep
                -- whichever row arrived last — so switching venues mid-outage
                -- would rewrite history rather than record it.
                UNIQUE (provider, symbol, interval, timestamp)
            );

            -- Every read of this table is a range over time for one
            -- (provider, symbol, interval), and the unique constraint above
            -- already carries that prefix, so the index that serves them is the
            -- one the constraint builds. Descending, because the only two reads
            -- that run on a hot path — the last known bar and the rows a
            -- backfill still needs — both walk backwards from the newest.
            CREATE INDEX IF NOT EXISTS idx_market_candles_recent
            ON market_candles (provider, symbol, interval, timestamp DESC)
            WHERE is_closed;
        `,
    };
