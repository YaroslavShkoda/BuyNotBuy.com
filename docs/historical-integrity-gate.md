# Historical integrity activation gate

YAR-82 adds an executable, read-only inventory and a per-response historical
identity check. It extends the YAR-69/71/80 controls; it does not change signals,
indicator formulas, backtest arithmetic, or outcome calculations.

Run against an explicitly selected database with a read-only database role:

```powershell
$env:DATABASE_URL = '<explicit read-only connection string>'
node --import=tsx src/backend/history/historical-integrity.cli.ts <from-ms> <to-ms>
```

There is no automatic `.env` loading. Both bounds are inclusive candle opening
timestamps, and must refer to closed bars. Exit 0 means every declared series
passed; exit 1 means an integrity blocker; exit 2 means the inventory could not
be completed. A failure to query is never GO. The CLI prints JSON evidence;
archive it with the command, deployment capability declaration, UTC collection
time, schema version, commit SHA and CI run before an owner activation decision.

`historical-inventory.ts` exports the separate `HISTORICAL_INVENTORY_SQL` evidence
query. `$1` is the JSON interval-duration map (`15m=900000`, `1h=3600000`,
`4h=14400000`, `1d=86400000`). It runs in a repeatable-read, read-only transaction.
Inventory includes every configured venue × symbol × supported interval,
including empty series, and separately reports stored undeclared series.
It counts closed and forming rows, first/last closed bars, duplicate timestamps,
gaps, UTC misalignment, invalid OHLCV, canonical instrument-link mismatches and
volume outliers. Gaps cover the entire stored closed series, not only the requested
coverage window. Coverage requires both bounds. Freshness allows at most two
intervals since the latest closed opening timestamp; a future closed bar blocks.
This policy is for the configured continuous crypto series. An exchange calendar
must be supplied before extending it to markets with scheduled closures.

Duplicate timestamps, gaps, misalignment, invalid candles, instrument mismatches,
insufficient coverage, stale data, mismatched series, unknown or contradictory
provenance each prevent activation of that series. Undeclared stored series also
prevent the aggregate GO. Volume above 100 times the series median is a warning
for review; it is not proof of contamination. No price-range rule can produce GO.

## Provenance and its limits

Built-in Binance, Bitget and mock providers now return historical candles with
the venue, requested symbol and interval from the same provider invocation.
Failover checks its selected physical venue against the returned envelope and
rejects contradictory claims; mutable
`activeVenue` is not used to attribute an earlier request. Both ingestion and
backfill reject a response naming another venue, ticker, or interval before
writing any row. Fallback candles are refused when their physical venue differs
from the requested storage key; they are never relabelled as the primary venue.
Provider-object symbol mismatch and inconsistent caller interval duration are
refused before the network request. Every response page is validated for safe,
nonnegative, UTC-aligned opening timestamps before the first write. Future
openings are refused; ingestion may retain the current forming bar as forming,
while backfill refuses bars that have not yet closed.
Rejections increment `provider_errors_total` with finite `operation` and `reason`
labels (`symbol_mismatch`, `venue_mismatch`, `interval_mismatch`,
`timestamp_invalid`, `candle_not_closed`, `provenance_unavailable`). The failover
trust check uses `operation=historical`; the writers use `ingestion` or `backfill`.

The method is optional in the general provider interface so non-writing consumers
retain API compatibility. Both historical writers require it: an integration
implementing only bare `getHistoricalCandles()` is rejected before fetching or
writing, with the explicit `provenance_unavailable` counter reason. No attribution
is fabricated from the requested storage key.

The current schema stores provider/symbol/interval claims, not raw venue response
receipts. Duplicating these claims into additional columns would not independently
prove upstream truth. Accordingly the inventory reports `stored-attribution-only`,
`independentSourceVerification: NOT_TESTED`, and counts stored rows as unknown
provenance. The gate conservatively stays blocked until an independently reviewed
source comparison establishes historical identity. This version deliberately
provides no switch that turns a price-range check or a copied label into source
verification. No production inventory or independent exchange comparison was
performed during implementation; local synthetic PostgreSQL evidence is test
evidence only.

Binance and Bitget can legitimately differ in OHLC, volume, bar publication time,
trade aggregation and subsequent revisions. Compare the same physical venue,
symbol, spot/derivative instrument type, UTC opening timestamps and interval;
document missing bars, precision and volume units before choosing tolerances.
Never compare a spot quote directly with perpetual/futures candles or treat a
cross-venue basis as contamination by itself. Use an independent source only
with reliable access and permitted usage, and retain raw responses or hashes
with collection times. If unavailable, record NOT_TESTED and keep activation
blocked; do not estimate source identity from plausible prices.

## Regression evidence

`historical-provenance.test.ts` injects structurally plausible candles with wrong
venue, ticker and interval envelopes, asserts both writers refuse them, checks
the explicit metric reason, and verifies the table remains empty. It also races
BTC/ETH ingestion and backfill through fresh repository instances, repeats writes
after restart, and verifies one row per identity. `historical-inventory.test.ts`
checks empty-series coverage, gaps, unknown source attribution, undeclared rows,
and compares every stored row before/after the read-only snapshot. The pure gate
tests independently exercise each blocker and volume warnings without prices.

```powershell
npx vitest run src/backend/history src/backend/market/failover.provider.test.ts src/backend/market/providers
```

Tests require an isolated local PostgreSQL database. The repository test harness
creates a distinct schema for each file and removes it afterward.
