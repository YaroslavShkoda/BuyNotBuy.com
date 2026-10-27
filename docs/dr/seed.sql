-- Synthetic data only. Run exclusively in a newly created drill source DB.
BEGIN;
INSERT INTO asset (symbol, category, source, decided_at)
VALUES ('BTC', 'crypto', 'configured', 1792886400000),
       ('ETH', 'crypto', 'configured', 1792886400000),
       ('USDT', 'crypto', 'configured', 1792886400000);
INSERT INTO instrument (ticker, base_asset, quote_asset, market_kind)
VALUES ('BTCUSDT', 'BTC', 'USDT', 'crypto'),
       ('ETHUSDT', 'ETH', 'USDT', 'crypto');
INSERT INTO market_candles
    (provider, symbol, interval, timestamp, open, high, low, close, volume, ingested_at, is_closed)
SELECT provider, symbol, interval, 1792886400000 + n * 86400000::bigint,
       price + n, price + n + 10, price + n - 10, price + n + 1,
       n + 100, 1793145600000, true
FROM (VALUES ('BTCUSDT', 60000), ('ETHUSDT', 3000)) AS markets(symbol, price)
CROSS JOIN (VALUES ('dr-venue-a'), ('dr-venue-b')) AS venues(provider)
CROSS JOIN (VALUES ('1h'), ('1d')) AS intervals(interval)
CROSS JOIN generate_series(0, 2) AS series(n);
INSERT INTO signal_history
    (symbol, provider, interval, hour_bucket, timestamp, signal, consensus, price,
     regime, data_quality, data_quality_usable, data_quality_worst)
SELECT symbol, provider, interval, timestamp, timestamp, 'NEUTRAL', 50, close,
       'dr-fixture', 1, true, NULL
FROM market_candles;
COMMIT;
