-- Run from the repository root. The changed full-row manifest must differ.
BEGIN;
UPDATE market_candles SET ingested_at = ingested_at + 1 WHERE id = 1;
\i docs/dr/manifest.sql
ROLLBACK;
