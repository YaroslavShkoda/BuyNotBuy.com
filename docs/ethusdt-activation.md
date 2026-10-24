# ETHUSDT activation gate

This document is the gate for serving a second market in production. It is the
checklist, not the approval: production trading activation happens only with an
explicit owner decision. Nothing here has been activated yet — the default
deployment observes `BTCUSDT` alone, and every setting below is commented out in
`.env.example`.

## What activation changes

Two settings, against the default deployment:

```
MARKET_SYMBOLS=ETHUSDT
MARKET_VENUE_CAPABILITIES=binance=BTCUSDT,ETHUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h
```

`MARKET_SYMBOL` stays `BTCUSDT`: the frozen `/api/market` and `/api/analysis`
routes keep answering the primary market, and ETHUSDT arrives as the routed
market behind `/api/instruments/ETHUSDT/market`, `/api/instruments/ETHUSDT/analysis`,
and the `/market/ETHUSDT` deep link. Both venues must declare both markets at
`MARKET_CANDLE_INTERVAL`, because the default failover (`bitget`) may only back
up a market it declares.

## What the process refuses at boot

A misconfigured activation never starts. The config load refuses:

- a ticker the asset registry cannot resolve (`MARKET_SYMBOLS=ETTHUSDT`);
- a configured market no venue declares, or declares only at another interval;
- a fallback that does not serve the primary market at the configured interval
  (so the chain cannot fail over into another asset);
- `MARKET_FALLBACK_SYMBOL` naming a different market than `MARKET_SYMBOL`;
- `mock` anywhere in the fallback list, and a mock primary outside tests.

## What is already verified in CI

At `b843f57` and after, the multi-market machinery is covered end to end:
`MARKET_SYMBOLS` parsing and dedup (`market.config.test.ts`), routing a venue
per market with capability-filtered failover chains (`market.provider.test.ts`),
cache and single-flight keyed by `SYMBOL|INTERVAL` (`market-isolation.test.ts`),
per-market breakers (`breaker-per-market.test.ts`), the instrument routes with
404 for an unknown ticker (`instrument-market.route.test.ts`,
`instrument-analysis.route.test.ts`), the full cycle and ingestion identity for
a second market (`market-cycle.test.ts`, `ingestion.identity.test.ts`), and the
`MARKET_INSUFFICIENT_HISTORY` (503) path the dashboard renders as a
not-enough-history state (`src/app/lib/interval.ts`,
`src/app/market/[symbol]/page.tsx`).

The exact deployment `.env.example` documents is rehearsed as a whole in
`ethusdt-activation.readiness.test.ts`.

## Activation day steps

1. Set the two settings above, deploy, and read the boot log: the market/venue
   refusals pass silently, `registry_seeded` and one `market_venue_active` per
   market follow.
2. Backfill ETHUSDT history before judging signals:
   `BACKFILL_MARKET=ETHUSDT BACKFILL_MAX_CANDLES=1000 npm run backfill`.
   Until the series covers the indicator warm-up window, ETH requests answer
   `MARKET_INSUFFICIENT_HISTORY` by design — that is the gate working, not a
   fault.
3. Check `/api/instruments/ETHUSDT/market` answers 200 with `X-Data-Stale: false`,
   `/api/market` still answers BTCUSDT, `/market/ETHUSDT` renders, and an
   unknown ticker still 404s.
4. Watch the provider metrics for both markets: freshness per market, cache
   hits/misses per market, and any `market_venue_switched` line naming its
   market.

## What CI cannot verify

- Live reachability of both venues from the production host for ETHUSDT. The
  fallback exists precisely because the primary is unreachable from some
  networks; only the host itself can answer this.
- Venue rate-limit headroom once the second market's polling and backfill join
  the first.

## Rollback

Remove `MARKET_SYMBOLS` (and the `MARKET_VENUE_CAPABILITIES` override) and
restart: the process returns to one market. Stored ETHUSDT rows stay keyed by
their own series and are read again on a later activation.
