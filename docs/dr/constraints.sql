-- Restore must retain both sequence state and the instrument-link trigger.
-- Roll back every write; sequence gaps after this check are intentional.
BEGIN;
DO $$
DECLARE next_id bigint;
BEGIN
    INSERT INTO market_candles
        (provider, symbol, interval, timestamp, open, high, low, close, volume, ingested_at)
    VALUES ('dr-sequence', 'BTCUSDT', '1h', 1793145600000, 10, 11, 9, 10, 1, 1793145600000)
    RETURNING id INTO next_id;
    IF next_id <= 24 THEN
        RAISE EXCEPTION 'restored sequence did not advance beyond fixture IDs';
    END IF;
    IF NOT EXISTS (SELECT FROM market_candles WHERE id = next_id AND instrument_id IS NOT NULL) THEN
        RAISE EXCEPTION 'instrument-link trigger did not resolve the fixture';
    END IF;
    BEGIN
        INSERT INTO market_candles
            (provider, symbol, interval, timestamp, open, high, low, close, volume, ingested_at)
        VALUES ('dr-invalid', 'NOPEUSDT', '1h', 1793145600000, 10, 11, 9, 10, 1, 1793145600000);
        RAISE EXCEPTION 'unknown instrument was accepted';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
END;
$$;
ROLLBACK;
