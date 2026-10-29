# Data freshness and provenance readiness — YAR-98

29 October2026. This is an independently reviewable refresh plan and read-only evidence, not an import, market activation or release approval. Source base: PR21 `efbf668e40e8e265d60a7b38d48507d4d9810c30`. Frontend PR22/23 is separate and does not fix market data readiness.

## Current read-only inventory

The existing local container `buynotbuycom-postgres-1` was stopped after a host interruption. It was restarted for this inventory; initial `pg_isready` returned no response, then accepting connections. No application startup, migration, backfill or SQL write was performed. Container startup/recovery is an operational action, distinct from the read-only SQL below. It is not an external staging environment.

Inventory at `2026-10-29T16:02:36.179Z`: PostgreSQL18.6, database/role `buynotbuy`, ledger26/26. Two explicit REPEATABLE READ READ ONLY snapshots; default session read-only also on. The existing repository `HISTORICAL_INVENTORY_SQL` was used with the canonical interval-duration map; query SHA256 `d161fbc5c2d44b7d8a9be23d1f034d1ab925f7ae943df7e84c624fdb79cc7873`.

| Stored physical venue/market/interval | Closed rows | Opening timestamp span UTC | Quality | Status |
| --- | --- | --- | --- | --- |
| binance/BTCUSDT/1h |618|03 Oct05:00 →28 Oct22:00|0 duplicate/gap/misaligned/identity/invalid/volume anomaly;618 unknown provenance|STALE, NO_GO|
| binance/ETHUSDT/1h |592|04 Oct07:00 →28 Oct22:00|same structural zeros;592 unknown provenance|STALE, NO_GO|
| binance/SOLUSDT/1h |376|04 Oct07:00 →19 Oct22:00|structural zeros;376 unknown provenance|Outside BTC/ETH scope; preserve|

BTC/ETH last bar closes28 Oct23:00UTC; age17.043h at observation. Current fresh-window coverage is incomplete. No Bitget rows were present. These observed keys do not assert which markets/intervals are activated in a deployment.

Full candle row count1586 and SHA256 `29cf98ed58f4e7f926338b259905369209810a7ed03acf24a8130a26e1c2cef5` agree across both snapshots. Hash format is documented in [inventory JSON](data-readiness-inventory-2026-10-29.json); it differs from earlier fingerprint domains and must not be compared to them as though they used identical bytes. Agreement across snapshots is not proof against unrelated future writers.

The inventory intentionally counts all stored rows as unknown provenance: storage labels are not independent receipts. Refreshing a timestamp alone will not make this checker report GO. The plan below includes a verified receipt-to-row evidence path rather than disabling this conservative guard.

## Bounded official-source observations

Two single unauthenticated requests, each with limit3, curl exit0, no redirects/alternate-host/proxy/geolocation workaround:

- Binance's configured `api.binance.com/api/v3/klines` returned HTTP451. Stopped Binance sampling; no alternate Binance URL was tried. No Binance candles verified.
- Bitget's existing adapter endpoint `/api/v2/spot/market/candles?symbol=BTCUSDT&granularity=1h&limit=3` returned HTTP200/code00000:3 rows,0 duplicate/invalid OHLCV/alignment/future errors.14:00 and15:00UTC were closed;16:00UTC was forming and excluded from closed evidence. This verifies only a tiny current BTC sample from that request, not ETH, retention depth, the deployed adapter or stored history.

The Bitget payload does not echo venue/symbol/interval; receipt identity comes from the exact official TLS request contract plus the versioned adapter validation, not a new claim that those fields were present in the response. No returned bar was imported. Bitget prices cannot validate or fill a Binance series.

Raw bounded responses/headers and read-only replay script are retained locally under ignored `data/source-readiness/`; sanitized request/hash/validation receipt is [samples JSON](data-readiness-samples-2026-10-29.json). Binance raw224-byte SHA `79c1db471a4cdc1c8565b5dfc52e0ed2d29962738ee4d28597696fcd0920e348`; Bitget403-byte SHA `54947527ed029d09cfedc760e86c581dfa55c2ca0f0cec03317db2da8f81dc36`.

Primary documentation checked29 October: [official Binance REST source](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md), [official market-data-only guide](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md), [current Bitget market data](https://www.bitget.com/docs/catalog/market/market-data). Bitget's old v2 documentation URL now redirects to UTA overview; current documentation describes v3. The successful bounded v2 request does not establish a long-term support promise or authorize an adapter migration. Protocol/version compatibility must be checked before a future collector rollout.

## Ordered execution plan — future approved refresh

1. **Pin identity and preserve baseline.** Owner names the exact local/staging target, operator, immutable candidate, physical venue/symbol/interval set, closed-bar window, request/bar budget, timeouts, storage path and overwrite policy. Read back database/server/role/ledger and effective configuration against that independent record. Retain verified backup plus current source fingerprints/registry/strategy versions. Never derive the expected identity from the credentials being tested. Existing SOL and prior research assets stay untouched.
2. **Resolve the source before writes.** Binance remains blocked until an authorized, unrestricted target can use the official service normally; do not route around451. A separately approved Bitget collection uses its own `bitget:<symbol>:<interval>` key. It neither impersonates Binance nor changes configured primary/market activation. Recheck small BTC and ETH samples and actual adapter response identity on the intended target, then stop on any mismatch, transport restriction or undocumented version response.
3. **Freeze an immutable receipt manifest.** Before database import, retain raw public response bytes, exact endpoint/parameters, request/receipt/server UTC times, physical venue, symbol, interval, API+adapter revision, raw SHA256, canonical per-bar hash, closed/rejected/duplicate counts and validation reason. Separate forming bars; never silently convert them to closed. Keep the receipt store immutable/versioned with a stable row-to-response mapping. An unverified caller-supplied venue string is not evidence.
4. **Prove the evidence bridge in a disposable database.** Implement/review a narrow receipt registry or sealed external manifest verifier with deterministic matching of every candidate row to a verified source receipt. Test malformed/missing/mutated receipts, wrong venue/market/interval, duplicate/restart/concurrent fetches, future/forming bars and idempotence. Existing `fetchHistoricalForSeries` guards stay intact. The current SQL-only inventory must keep reporting unknown unless independently verified evidence is actually composed with it; no direct edits to unknownProvenanceCount or relabelling legacy rows.
5. **Rehearse a bounded non-overwriting refresh.** In the disposable database only, ingest approved closed bars with explicit caps, record inserted/updated/rejected counts and compare all outside-scope hashes. Existing backfill CLI can overwrite via ON CONFLICT DO UPDATE and walks backwards from the oldest row; it is not an append-only fresh-gap repair tool. Do not blindly run `npm run backfill` against the working database. Select or implement the narrow append/gap path and independently prove that overlap cannot alter prior research inputs. Any intended correction needs a separately reviewed diff and overwrite decision.
6. **Apply only after scoped approval.** Present the exact proposed keys/window/counts, code+manifest hashes, backup/rollback plan and expected insert/overwrite budget to the owner. On approval, verify target/role/config again and execute that bounded plan. Stop at an unexpected count/identity/source/lock condition. Do not enable additional markets, change signals or run the application poller as an implicit refresh mechanism.
7. **Reconcile and gate.** Record before/after hashes and counts for the exact keys; fresh closed-bar coverage, order/alignment/OHLCV/gaps/duplicates, no-future, physical attribution, receipt matching, outside-scope preservation and restart idempotence must all pass. Run the historical integrity gate plus independent receipt verifier without dropping either failure. A fresh sample or readiness200 cannot override provenance/coverage failures. A green data gate still requires separate YAR-85/79 decisions before activation/release.
8. **Keep prospective research separate.** YAR-84 protocol/owner receipt stay immutable. Four venue/market strategy series require future observations under their registered windows and sample/stopping rules. Old CSVs, newly downloaded historical bars and today's two closed Bitget sample bars are not an experiment result.333 effective daily blocks and calibration requirements cannot be asserted from a row count; state remains INCONCLUSIVE/not_calibrated until actual eligible evidence and comparisons exist.

## Required evidence per phase

Target and code identity; query/request/command and individual exit codes; UTC observation/window; raw/canonical hashes and receipt mapping; inserted/overwritten/rejected/remaining counts; structural and source gates; PASS/FAIL/NOT_TESTED; limitation; reviewer/operator and next action. Keep secrets, credentials and backups outside Git/Linear. Publish sanitized evidence only.

| Blocker | Current evidence | Removal condition |
| --- | --- | --- |
| Fresh BTC/ETH coverage | stale17h, incomplete current window | Approved bounded closed-bar refresh and full coverage proof |
| Stored source identity |1210 BTC/ETH rows unknown | Independently reviewed receipt-to-row verifier and actual matching receipts |
| Binance availability | HTTP451, no candles | Authorized normal official access; no workaround |
| Bitget readiness |2 closed current BTC samples only | Target-specific BTC/ETH/interval/adapter checks, approved separate key and evidence store |
| Backfill overwrite safety | CLI may replace historical inputs | Proved narrow non-overwriting path or explicit correction diff approval |
| Research evidence | Future experiment not completed | Registered eligible collection, sample threshold and prescribed comparisons |
| External release | Staging owner-deferred | Actual target/failover/alerts/restore and explicit owner YAR-79 decision |

**Decision: NO_GO for data activation/release.** YAR-82 checker Done and YAR-98 plan delivery do not mean source/freshness readiness. This task performed0 SQL writes,0 imports/backfills,0 migrations and0 market activations. Normal local container startup is disclosed above. No paid service or external infrastructure was provisioned.
