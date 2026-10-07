import type { Migration } from './types.js';

export const migration024_instrument_links_for_signal_data: Migration = {
    version: 24,
    name: 'instrument_links_for_signal_data',
    sql: `
        ALTER TABLE indicator_vote ADD COLUMN IF NOT EXISTS instrument_id BIGINT;
        ALTER TABLE signal_state ADD COLUMN IF NOT EXISTS instrument_id BIGINT;
        ALTER TABLE signal_transition ADD COLUMN IF NOT EXISTS instrument_id BIGINT;
        ALTER TABLE strategy_decision_log ADD COLUMN IF NOT EXISTS instrument_id BIGINT;

        UPDATE indicator_vote v SET instrument_id = i.id
        FROM instrument i WHERE v.instrument_id IS NULL AND v.symbol = i.ticker;
        UPDATE signal_state s SET instrument_id = i.id
        FROM instrument i WHERE s.instrument_id IS NULL AND s.symbol = i.ticker;
        UPDATE signal_transition t SET instrument_id = i.id
        FROM instrument i WHERE t.instrument_id IS NULL AND t.symbol = i.ticker;
        UPDATE strategy_decision_log d SET instrument_id = i.id
        FROM instrument i WHERE d.instrument_id IS NULL AND d.symbol = i.ticker;

        ALTER TABLE indicator_vote ADD CONSTRAINT indicator_vote_instrument_fk
            FOREIGN KEY (instrument_id) REFERENCES instrument (id) ON DELETE RESTRICT;
        ALTER TABLE signal_state ADD CONSTRAINT signal_state_instrument_fk
            FOREIGN KEY (instrument_id) REFERENCES instrument (id) ON DELETE RESTRICT;
        ALTER TABLE signal_transition ADD CONSTRAINT signal_transition_instrument_fk
            FOREIGN KEY (instrument_id) REFERENCES instrument (id) ON DELETE RESTRICT;
        ALTER TABLE strategy_decision_log ADD CONSTRAINT strategy_decision_log_instrument_fk
            FOREIGN KEY (instrument_id) REFERENCES instrument (id) ON DELETE RESTRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS indicator_vote_instrument_bucket_unique
            ON indicator_vote (instrument_id, vote_bucket, indicator);
        CREATE UNIQUE INDEX IF NOT EXISTS signal_state_instrument_series_unique
            ON signal_state (instrument_id, provider, interval);
        CREATE UNIQUE INDEX IF NOT EXISTS strategy_decision_instrument_time_unique
            ON strategy_decision_log (instrument_id, created_at);

        CREATE INDEX IF NOT EXISTS signal_transition_instrument_series_idx
            ON signal_transition (instrument_id, provider, interval, created_at DESC);

        CREATE TRIGGER indicator_vote_instrument_link
            BEFORE INSERT OR UPDATE OF symbol, instrument_id ON indicator_vote
            FOR EACH ROW EXECUTE FUNCTION set_market_row_instrument_id();
        CREATE TRIGGER signal_state_instrument_link
            BEFORE INSERT OR UPDATE OF symbol, instrument_id ON signal_state
            FOR EACH ROW EXECUTE FUNCTION set_market_row_instrument_id();
        CREATE TRIGGER signal_transition_instrument_link
            BEFORE INSERT OR UPDATE OF symbol, instrument_id ON signal_transition
            FOR EACH ROW EXECUTE FUNCTION set_market_row_instrument_id();
        CREATE TRIGGER strategy_decision_instrument_link
            BEFORE INSERT OR UPDATE OF symbol, instrument_id ON strategy_decision_log
            FOR EACH ROW EXECUTE FUNCTION set_market_row_instrument_id();
    `,
};
