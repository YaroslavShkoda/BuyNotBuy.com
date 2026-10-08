import type { FastifyReply } from 'fastify';

import type { MarketFreshness } from '../../market/market-freshness.js';

interface FreshnessHeaders {
    stale: boolean;
    ageMs: number;
    freshness: MarketFreshness;
    provider: string;
}

/**
 * Tells the consumer whether the payload is a live reading or a snapshot that
 * is being repeated because the upstream provider is unavailable.
 *
 * A stale response is a 200 on purpose: the candles describe the last closed
 * bar, which is still the correct picture of the market. Hiding them behind an
 * error would blank the dashboard every time Binance blinks. The header makes
 * the caveat machine-readable instead of leaving it to be guessed.
 *
 * Three headers rather than one, because "stale" was carrying two unrelated
 * facts and a client could not tell them apart:
 *
 * - `X-Data-Stale` — was this not freshly fetched. True both for a snapshot
 *   served from cache and for a current snapshot served while every venue is
 *   down. The old contract, unchanged, and still the right coarse answer.
 * - `X-Data-Freshness` — which of the six states it actually is, for a consumer
 *   that cares about the difference between "behind" and "channel dead".
 * - `X-Data-Provider` — which venue answered. A failover is otherwise
 *   indistinguishable from a market move, because the two venues print
 *   different numbers for the same hour.
 */
export function setDataFreshnessHeaders(
    reply: FastifyReply,
    headers: FreshnessHeaders,
): void {
    const { stale, ageMs, freshness, provider } = headers;

    reply.header('X-Data-Stale', stale ? 'true' : 'false');
    reply.header('X-Data-Age-Ms', String(Math.max(0, Math.round(ageMs))));
    reply.header('X-Data-Freshness', freshness);
    reply.header('X-Data-Provider', provider);
    reply.header('Cache-Control', stale ? 'no-store' : 'public, max-age=30');
}
