-- Stable across sessions: full rows (including IDs, NULLs and provenance),
-- ordered by their canonical JSON. SHA-256 is computed on the output file.
-- Suitable for the small drill fixture; large datasets need streaming hashes.
SET timezone = 'UTC';
SET extra_float_digits = 3;
SELECT 'asset', count(*), md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY to_jsonb(t)::text COLLATE "C"), '')) FROM asset t
UNION ALL
SELECT 'instrument', count(*), md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY to_jsonb(t)::text COLLATE "C"), '')) FROM instrument t
UNION ALL
SELECT 'market_candles', count(*), md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY to_jsonb(t)::text COLLATE "C"), '')) FROM market_candles t
UNION ALL
SELECT 'signal_history', count(*), md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY to_jsonb(t)::text COLLATE "C"), '')) FROM signal_history t
UNION ALL
SELECT 'schema_migrations', count(*), md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY to_jsonb(t)::text COLLATE "C"), '')) FROM schema_migrations t
ORDER BY 1;
