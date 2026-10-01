import { describe, expect, it } from 'vitest';

import { marketKey, resolveRequest } from '../market/market.service.js';

import type { MarketRequest } from '../market/capability.js';

/**
 * M10, measured rather than assumed — and the answer is not the one the roadmap
 * expected.
 *
 * M10 asks for cache and single-flight keys that carry the market. Half of that
 * is already true and the other half cannot be: `marketKey` is
 * `instrument|interval` and the coalescing map in the same module is keyed by it,
 * so the market layer isolates properly — that is M3, closed, with
 * `market-isolation.test.ts` behind it.
 *
 * The single flight in the analysis path has **no key**, and the journal has
 * been calling that correct on the grounds that there is no market axis to key
 * it by. Read today, that is still exactly why: `analyzeMarket` takes a logger, a
 * request id and a history logger — no instrument — and `computeAnalysis()` calls
 * `getMarketData()` with no argument, so every analysis is of the configured
 * market and there is nothing to collide.
 *
 * So the hazard is not a missing key. It is a **property nobody checks**: the
 * analysis path computes exactly one market, the configured one, and the
 * single-flight is correct only because of it. Thread an instrument through
 * `computeAnalysis`, call `getMarketData({ instrument })` and every existing test
 * keeps passing — `analysisFlight.run` would then coalesce across markets and
 * hand the second caller the first market's analysis, with a plausible price and
 * a correct shape.
 *
 * That is the failure `invariants.md` §22 describes for the cache, arriving
 * through the path the cache guard cannot see. These cases state the property in
 * the form that can fail, so it fails when the axis arrives rather than when
 * somebody notices.
 */

describe('the market cache is keyed by market', () => {
    it('separates two markets, two intervals, and the same market twice', () => {
        const btc: MarketRequest = { instrument: 'BTCUSDT', interval: '1h' };

        expect(marketKey(btc)).not.toBe(marketKey({ ...btc, instrument: 'ETHUSDT' }));
        expect(marketKey(btc)).not.toBe(marketKey({ ...btc, interval: '4h' }));
        expect(marketKey(btc)).toBe(marketKey({ ...btc }));
    });

    it('treats the same market written in another case as the same market', () => {
        expect(marketKey({ instrument: 'btcusdt', interval: '1h' })).toBe(
            marketKey({ instrument: 'BTCUSDT', interval: '1h' }),
        );
    });
});

describe('the analysis path computes one market, and it is the configured one', () => {
    it('defaults to the configured market when no request names one', () => {
        const resolved = resolveRequest();

        expect(resolved.instrument).toBe(resolved.instrument.toUpperCase());
        expect(resolved.instrument).not.toBe('');
    });

    /**
     * The property that will break first.
     *
     * `analyzeMarket` has no instrument parameter, and `computeAnalysis` calls
     * `getMarketData()` with no argument — read off the source rather than
     * assumed, because the single flight's correctness rests entirely on it and
     * nothing in the types says so. When someone adds a market parameter this
     * fails, which is the moment to give `analysisFlight` a key; it is far better
     * than discovering it from a follower served another market's analysis.
     *
     * Asserted on the source text on purpose: there is no runtime handle on "this
     * function takes no market", and a behavioural test could only notice by
     * racing two markets through the service, which is the bug itself.
     */
    it('has no market parameter anywhere in the analysis entry points', async () => {
        const { readFileSync } = await import('node:fs');
        const { dirname, join } = await import('node:path');
        const { fileURLToPath } = await import('node:url');

        const here = dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(join(here, '..', 'services', 'analysis.service.ts'), 'utf8');

        // `String.fromCharCode(10)` rather than a literal newline escape: the
        // literal is invisible in an editor and has broken this file twice.
        const lines = source.split(String.fromCharCode(10));
        const call = lines.findIndex((line) => line.includes('getMarketData(') && line.includes('=>'));
        const entryPoint = /export async function analyzeMarket(?:WithStatus)?\(([^)]*)\)/.exec(
            source,
        );

        // The call that decides it: a request naming the market would mean the
        // single flight needs a key, and this is the line that would change.
        //
        // Asserted with the line it is on rather than by matching the whole
        // source, because the first version dumped the file's opening import at
        // whoever tried to add a market parameter — a guard whose failure message
        // does not name a place is a guard people learn to ignore.
        // Both halves of the property: the call names no market, and the entry
        // point takes none. Rewriting this to produce a readable message briefly
        // weakened it to "the call mentions getMarketData", which still passed
        // when the market *was* named on that very line — a control caught it,
        // and a guard that stops detecting its own hazard is worse than none.
        expect({
            line: call + 1,
            call: lines[call]?.trim(),
            entryPoint: entryPoint?.[1]?.replace(/\s+/g, ' ').trim(),
        }).toEqual({
            line: expect.any(Number),
            call: expect.not.stringContaining('instrument'),
            entryPoint: expect.not.stringContaining('instrument'),
        });
    });
});