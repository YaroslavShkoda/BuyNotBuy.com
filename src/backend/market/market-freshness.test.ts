import { beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyFreshness, isUsableForSignal } from './market-freshness.js';
import { marketConfig } from '../config/market.config.js';

import type { MarketFreshness } from './market-freshness.js';

/**
 * The order of the checks in `classifyFreshness` is the contract, so most of
 * these drive several inputs at once and assert which one won. A table of
 * one-input cases would pass against almost any implementation.
 */
function input(overrides: Partial<Parameters<typeof classifyFreshness>[0]>) {
    return {
        ageMs: 0,
        providerAnswered: true,
        anyProviderAvailable: true,
        toleratedIssues: [],
        ...overrides,
    };
}

describe('classifyFreshness', () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    it('reports a fetch inside the TTL with a reachable venue as fresh', () => {
        expect(
            classifyFreshness(
                input({ ageMs: 0, providerAnswered: true }),
            ),
        ).toBe('fresh');
    });

    it('reports nothing to serve as unavailable', () => {
        expect(
            classifyFreshness(
                input({ ageMs: null, providerAnswered: false }),
            ),
        ).toBe('unavailable');
    });

    it('refuses a snapshot older than maxStaleMs even when the venue answered', () => {
        // The venue answering is the odd part and the point: reaching the
        // `expired` branch with a live provider would mean the cache was kept
        // and the refusal is about age, not about an outage. Age is checked
        // first precisely so the two cannot be confused.
        expect(
            classifyFreshness(
                input({
                    ageMs: marketConfig.maxStaleMs + 1,
                    providerAnswered: true,
                }),
            ),
        ).toBe('expired');
    });

    it('treats a snapshot exactly at the stale limit as still servable', () => {
        // Boundary: `>` and not `>=`. A snapshot exactly maxStaleMs old has
        // spent its entire budget and none beyond, and turning a last-instant
        // cache hit into an error is the kind of off-by-one that only shows up
        // during an outage.
        expect(
            classifyFreshness(
                input({
                    ageMs: marketConfig.maxStaleMs,
                    providerAnswered: false,
                    anyProviderAvailable: false,
                }),
            ),
        ).toBe('stale');
    });

    it('reports a past-TTL snapshot served after a failure as stale', () => {
        expect(
            classifyFreshness(
                input({
                    ageMs: marketConfig.cacheTtlMs + 1,
                    providerAnswered: false,
                    anyProviderAvailable: false,
                }),
            ),
        ).toBe('stale');
    });

    it('distinguishes a current snapshot with a dead feed from a stale one', () => {
        // The whole reason `provider_failed` exists. Both cases have
        // `providerAnswered: false`; only the age separates them, and collapsing
        // them would make a total outage indistinguishable from a cache hit.
        expect(
            classifyFreshness(
                input({
                    ageMs: 10,
                    providerAnswered: false,
                    anyProviderAvailable: false,
                }),
            ),
        ).toBe('provider_failed');
    });

    it('does not call it provider_failed while any venue can still answer', () => {
        expect(
            classifyFreshness(
                input({
                    ageMs: 10,
                    providerAnswered: false,
                    anyProviderAvailable: true,
                }),
            ),
        ).toBe('fresh');
    });

    it('reports a tolerated series defect as partially available', () => {
        expect(
            classifyFreshness(
                input({ toleratedIssues: ['has_gap' as const] }),
            ),
        ).toBe('partially_available');
    });

    it('prefers the data defect over the venue verdict', () => {
        // Both are true here. The data being wrong is the fact that survives
        // the outage — and a caller that fixed the feed and rebuilt the signal
        // from this snapshot would still be building on a hole.
        expect(
            classifyFreshness(
                input({
                    ageMs: 10,
                    providerAnswered: false,
                    anyProviderAvailable: false,
                    toleratedIssues: ['stale' as const],
                }),
            ),
        ).toBe('partially_available');
    });

    it('reports a series shorter than the warm-up as partially available', () => {
        expect(
            classifyFreshness(
                input({ requiredCandles: 999, actualCandles: 998 }),
            ),
        ).toBe('partially_available');
    });

    it('prefers expiry over partial availability', () => {
        // The order is deliberate and this pins it: over-age wins, because a
        // snapshot that is too old is refused regardless of what else is wrong
        // with it, and reporting "partially available" would invite a retry that
        // cannot help.
        expect(
            classifyFreshness(
                input({
                    ageMs: marketConfig.maxStaleMs + 1,
                    requiredCandles: 999,
                    actualCandles: 10,
                }),
            ),
        ).toBe('expired');
    });
});

describe('freshness predicates', () => {
    const states: MarketFreshness[] = [
        'fresh',
        'provider_failed',
        'stale',
        'partially_available',
        'expired',
        'unavailable',
    ];

    it('only lets a current snapshot build a signal', () => {
        const usable = states.filter(isUsableForSignal);

        expect(usable).toEqual(['fresh', 'provider_failed']);
    });

    /**
     * The fact underneath all of it: inside the TTL, a cache hit and a fetch are
     * the same state.
     *
     * This is decision-independent. Whether the predicate is repaired by carrying
     * the fact on the result or deleted for having no reader, this stays true —
     * `MarketFreshness` is a function of age, provider reachability and series
     * health, and none of those three distinguishes "answered from memory" from
     * "answered just now". The cache-hit branch of `getMarketData` proves it: it
     * calls `classifyFreshness` with `providerAnswered: false` and an age inside
     * the TTL, and gets `fresh` — the same word the fetch branch writes
     * literally.
     */
    it('cannot tell a cache hit from a fetch, because the state is the same', () => {
        const cacheHit = classifyFreshness(
            input({
                ageMs: 60_000,
                providerAnswered: false,
                anyProviderAvailable: true,
                requiredCandles: 400,
                actualCandles: 500,
            }),
        );

        // What `fetchMarketData` returns after a successful fetch, verbatim.
        const fetched: MarketFreshness = 'fresh';

        expect(cacheHit).toBe(fetched);
    });

});
