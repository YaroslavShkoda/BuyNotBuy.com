import type { FastifyReply } from 'fastify';

/**
 * Tells the consumer whether the payload is a live reading or a snapshot that
 * is being repeated because the upstream provider is unavailable.
 *
 * A stale response is a 200 on purpose: the candles describe the last closed
 * bar, which is still the correct picture of the market. Hiding them behind an
 * error would blank the dashboard every time Binance blinks. The header makes
 * the caveat machine-readable instead of leaving it to be guessed.
 */
export function setDataFreshnessHeaders(
    reply: FastifyReply,
    stale: boolean,
    ageMs: number,
): void {
    reply.header('X-Data-Stale', stale ? 'true' : 'false');
    reply.header('X-Data-Age-Ms', String(Math.max(0, Math.round(ageMs))));
    reply.header('Cache-Control', stale ? 'no-store' : 'public, max-age=30');
}
