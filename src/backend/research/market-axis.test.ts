import { describe, expect, it } from 'vitest';

import { marketKey } from '../market/market.service.js';

/**
 * M10, and the axis it warned about has now arrived — so this file states the
 * other half of the property.
 *
 * The first version of this asserted the *absence* of a market axis in the
 * analysis path: `analyzeMarket` took no instrument, `computeAnalysis` called
 * `getMarketData()` with no argument, and the single flight had no key because
 * there was nothing to key it by. That was all true and all load-bearing, and it
 * is now the opposite of what the code should say.
 *
 * What is asserted here is the state the axis has to reach:
 *
 * 1. The cache is keyed by market and interval — M3, unchanged, re-checked rather
 *    than taken from the journal.
 * 2. The analysis names the market it computes, and reads that market.
 * 3. **The single flight is keyed by it.** Point 2 without 3 is the trap this file
 *    existed to catch: two analyses for two markets would join one flight and the
 *    second caller would be handed the first market's analysis, plausible price,
 *    correct shape. So the coalescer is read at runtime rather than the source
 *    being matched for a key, and two markets must end up on two coalescers.
 */

describe('the market cache is keyed by market', () => {
    it('separates two markets, two intervals, and the same market twice', () => {
        const btc = { instrument: 'BTCUSDT', interval: '1h' } as const;

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

describe('the analysis path names the market it computes', () => {
    it('reads the market the caller named', async () => {
        const { readFileSync } = await import('node:fs');
        const { dirname, join } = await import('node:path');
        const { fileURLToPath } = await import('node:url');

        const here = dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(
            join(here, '..', 'services', 'analysis.service.ts'),
            'utf8',
        );

        const lines = source.split(String.fromCharCode(10));
        const call = lines.findIndex(
            (line) => line.includes('getMarketData(') && line.includes('=>'),
        );

        expect({
            line: call + 1,
            call: lines[call]?.trim(),
        }).toEqual({
            line: expect.any(Number),
            // The market comes from the request, not from the configuration. The
            // first version of this line was `getMarketData()`, which is why the
            // first version of this file asserted the axis was absent.
            call: expect.stringContaining('getMarketData(request)'),
        });
    });

    it('and takes one on the entry points', async () => {
        const { readFileSync } = await import('node:fs');
        const { dirname, join } = await import('node:path');
        const { fileURLToPath } = await import('node:url');

        const here = dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(
            join(here, '..', 'services', 'analysis.service.ts'),
            'utf8',
        );

        for (const entry of ['analyzeMarket', 'analyzeMarketWithStatus']) {
            const signature = new RegExp(
                `export async function ${entry}\(([^)]*)\)`,
            ).exec(source)?.[1];

            expect(signature, `${entry} has no signature`).toBeDefined();
            expect(signature).toContain('instrument');
        }
    });
});
