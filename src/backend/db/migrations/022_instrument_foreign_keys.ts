import type { Migration } from './types.js';

export const migration022_instrument_foreign_keys: Migration = {
    version: 22,
    name: 'instrument_foreign_keys',
    sql: `
        -- Give the canonical instrument a stable database identity while
        -- keeping ticker as its externally useful, unique spelling.
        ALTER TABLE instrument
            ADD COLUMN IF NOT EXISTS id BIGINT GENERATED ALWAYS AS IDENTITY;
        CREATE UNIQUE INDEX IF NOT EXISTS instrument_id_unique ON instrument (id);

        -- Historical rows are linked wherever migration 15's registry already
        -- knows their ticker. Unknown historical symbols remain readable with
        -- a NULL link; the write trigger below requires every new/changed row
        -- to resolve to a canonical instrument.
        ALTER TABLE market_candles ADD COLUMN IF NOT EXISTS instrument_id BIGINT;
        ALTER TABLE signal_history ADD COLUMN IF NOT EXISTS instrument_id BIGINT;
        ALTER TABLE signal_outcome ADD COLUMN IF NOT EXISTS instrument_id BIGINT;
        ALTER TABLE signal_snapshot ADD COLUMN IF NOT EXISTS instrument_id BIGINT;

        UPDATE market_candles c SET instrument_id = i.id
        FROM instrument i WHERE c.instrument_id IS NULL AND c.symbol = i.ticker;
        UPDATE signal_history h SET instrument_id = i.id
        FROM instrument i WHERE h.instrument_id IS NULL AND h.symbol = i.ticker;
        UPDATE signal_outcome o SET instrument_id = i.id
        FROM instrument i WHERE o.instrument_id IS NULL AND o.symbol = i.ticker;
        UPDATE signal_snapshot s SET instrument_id = i.id
        FROM instrument i WHERE s.instrument_id IS NULL AND s.symbol = i.ticker;

        ALTER TABLE market_candles ADD CONSTRAINT market_candles_instrument_fk
            FOREIGN KEY (instrument_id) REFERENCES instrument (id) ON DELETE RESTRICT;
        ALTER TABLE signal_history ADD CONSTRAINT signal_history_instrument_fk
            FOREIGN KEY (instrument_id) REFERENCES instrument (id) ON DELETE RESTRICT;
        ALTER TABLE signal_outcome ADD CONSTRAINT signal_outcome_instrument_fk
            FOREIGN KEY (instrument_id) REFERENCES instrument (id) ON DELETE RESTRICT;
        ALTER TABLE signal_snapshot ADD CONSTRAINT signal_snapshot_instrument_fk
            FOREIGN KEY (instrument_id) REFERENCES instrument (id) ON DELETE RESTRICT;

        CREATE INDEX IF NOT EXISTS market_candles_instrument_series_idx
            ON market_candles (instrument_id, provider, interval, timestamp DESC);
        CREATE INDEX IF NOT EXISTS signal_history_instrument_series_idx
            ON signal_history (instrument_id, provider, interval, hour_bucket DESC);
        CREATE INDEX IF NOT EXISTS signal_outcome_instrument_series_idx
            ON signal_outcome (instrument_id, provider, interval, horizon_bars, verdict);
        CREATE INDEX IF NOT EXISTS signal_snapshot_instrument_idx
            ON signal_snapshot (instrument_id, created_at DESC);

        -- A trigger keeps the compatibility symbol column and canonical FK in
        -- agreement, including for direct SQL writers and retry tooling.
        CREATE FUNCTION set_market_row_instrument_id() RETURNS trigger AS $$
        DECLARE resolved_id BIGINT;
        BEGIN
            SELECT id INTO resolved_id FROM instrument WHERE ticker = NEW.symbol;
            IF resolved_id IS NULL THEN
                RAISE EXCEPTION 'unknown instrument ticker: %', NEW.symbol
                    USING ERRCODE = '23503';
            END IF;
            IF NEW.instrument_id IS NOT NULL AND NEW.instrument_id <> resolved_id THEN
                RAISE EXCEPTION 'instrument_id does not match symbol %', NEW.symbol
                    USING ERRCODE = '23514';
            END IF;
            NEW.instrument_id := resolved_id;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER market_candles_instrument_link
            BEFORE INSERT OR UPDATE OF symbol, instrument_id ON market_candles
            FOR EACH ROW EXECUTE FUNCTION set_market_row_instrument_id();
        CREATE TRIGGER signal_history_instrument_link
            BEFORE INSERT OR UPDATE OF symbol, instrument_id ON signal_history
            FOR EACH ROW EXECUTE FUNCTION set_market_row_instrument_id();
        CREATE TRIGGER signal_outcome_instrument_link
            BEFORE INSERT OR UPDATE OF symbol, instrument_id ON signal_outcome
            FOR EACH ROW EXECUTE FUNCTION set_market_row_instrument_id();
        CREATE TRIGGER signal_snapshot_instrument_link
            BEFORE INSERT OR UPDATE OF symbol, instrument_id ON signal_snapshot
            FOR EACH ROW EXECUTE FUNCTION set_market_row_instrument_id();
    `,
};
