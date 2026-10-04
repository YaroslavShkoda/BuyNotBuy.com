import { describe, expect, it, vi } from 'vitest';

vi.mock('../history/signal-history.service.js', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

import * as marketService from '../market/market.service.js';
import { marketData } from '../test-support/market-data.js';
import { freshMarketData } from '../test-support/market-data-result.js';
import { analyzeMarketWithStatus } from './analysis.service.js';

const rising = () =>
    freshMarketData(
        marketData(
            Array.from({ length: 900 }, (_, index) => ({
                timestamp: index,
                open: 100,
                high: 100 + index,
                low: 100,
                close: 100 + index,
                volume: 1000,
            })),
            { price: { symbol: 'BTCUSDT', price: 1_200 } },
        ),
    );

const falling = () =>
    freshMarketData(
        marketData(
            Array.from({ length: 900 }, (_, index) => ({
                timestamp: index,
                open: 1_200 - index,
                high: 1_200,
                low: 1_100 - index,
                close: 1_200 - index,
                volume: 1000,
            })),
            { price: { symbol: 'BTCUSDT', price: 400 } },
        ),
    );

async function withMarket(
    factory: () => ReturnType<typeof rising>,
    body: (result: Awaited<ReturnType<typeof analyzeMarketWithStatus>>) => void,
): Promise<void> {
    vi.spyOn(marketService, 'getMarketData').mockImplementation(factory as never);

    await body(await analyzeMarketWithStatus());
}

/**
 * The explanation has to be about the signal that was published.
 *
 * `explanation.ts` sat unwired for its whole life with a comment claiming the
 * reason and the explanation were generated from one partition and so were
 * "incapable of disagreeing". Nothing checked it, because nothing produced
 * both of them. Now something does, and these are the tests that would notice
 * if a second rendering appeared beside the first.
 */
describe('the explanation describes the published signal', () => {
    it('is about the same direction, and says the reason it published', async () => {
        await withMarket(rising, (result) => {
            const { analysis, explanation } = result;

            expect(explanation.direction).toBe(analysis.signal.signal);
            expect(explanation.reason).toBe(analysis.signal.reason);
            expect(explanation.confidence.value).toBe(analysis.signal.confidence);
        });
    });

    /**
     * Why the sentence agrees, and what this test therefore cannot see.
     *
     * `explanation.reason` is **not** the published string passed through. I
     * tampered with the input and the tests stayed green; a `throw` in the same
     * call then proved the code path was running. Both renderings call the same
     * `describeSignal` over the same partition, and `describeSignal` rebuilds the
     * sentence whenever at least one indicator supported the verdict, discarding
     * the `reason` argument entirely. It survives only as the floor used for
     * `NEUTRAL`.
     *
     * So the agreement is a property of the *generator*, not of the string
     * being handed over — and a control has to break the generator's inputs
     * rather than the argument the generator throws away. That is why the
     * negative control for this block tampers with the direction.
     */
    it('names exactly the indicators that supported the verdict', async () => {
        // Two renderings agreeing is necessary but not sufficient: they could
        // agree by reading the same array and describing nothing at all. This
        // checks the sentence actually accounts for the votes.
        await withMarket(rising, ({ analysis, explanation }) => {
            const supporting = analysis.signal.indicators
                .filter((indicator) => indicator.signal === analysis.signal.signal)
                .map((indicator) => indicator.name);

            expect(supporting.length).toBeGreaterThan(0);

            for (const name of supporting) {
                expect(explanation.reason).toContain(name);
            }

            const opposing = analysis.signal.indicators.filter(
                (indicator) =>
                    indicator.signal !== analysis.signal.signal &&
                    indicator.signal !== 'NEUTRAL',
            );

            for (const indicator of opposing) {
                expect(explanation.reason).not.toContain(indicator.name);
            }
        });
    });

    it('partitions the indicators the signal was made of', async () => {
        await withMarket(rising, ({ analysis, explanation }) => {
            const published = analysis.signal.indicators;

            // Every indicator is accounted for exactly once. A partition that
            // dropped the neutral ones would still look reasonable in a reader —
            // "three said no opinion" is not what "no opinion" usually gets
            // reported as.
            expect(explanation.supporting.length + explanation.opposing.length +
                explanation.abstaining.length).toBe(published.length);

            for (const indicator of published) {
                const bucket = [
                    ...explanation.supporting,
                    ...explanation.opposing,
                    ...explanation.abstaining,
                ].filter((entry) => entry.key === indicator.key);

                expect(bucket).toHaveLength(1);
            }
        });
    });

    it('reports the number as a panel share, never as a probability', async () => {
        // The single most important thing this field carries. A published "71%
        // confidence" that a reader takes as "71% likely to be right" is the
        // most expensive misreading available in this project, and nothing else
        // in the response says otherwise.
        await withMarket(falling, ({ explanation }) => {
            expect(explanation.confidence.isProbabilityOfBeingRight).toBe(false);
            expect(explanation.confidence.meaning).not.toBe('');
        });
    });

    it('carries the market it was decided in', async () => {
        // 900 perfectly linear bars read as `RANGE`, not `TREND_UP` — and I
        // wrote `TREND_UP` first, on the assumption that a straight line up is a
        // trend. It is not, by this project's own definition: a line that rises
        // the same amount every bar has no pullback to have broken out of. The
        // assertion below is what the series actually produces, and it is
        // pinned rather than loosened, because "some label from the enum" would
        // pass no matter what the regime code returned.
        //
        // The history row keeps that as the string `RANGE/…`; the explanation
        // keeps the two axes and the reliability warning, which is the only
        // reason it can say how far to trust the label at all.
        await withMarket(rising, ({ explanation }) => {
            expect(explanation.regime).not.toBeNull();
            expect(explanation.regime?.trend).toBe('RANGE');
            expect(explanation.regime?.volatility).toBeTypeOf('string');

            // The test series is timestamped 1970, so the quality assessment
            // says `freshness` and scores it below the usable floor. I wrote
            // `usable: true` first, on the assumption that 900 good bars are
            // good data; they are good data about 1970.
            //
            // What matters is that the explanation carries **the reason** and
            // not only the verdict: "not usable" with no factor attached can be
            // acted on by nobody, and a flag that arrives without a cause is
            // the same information in half the size.
            expect(explanation.quality?.usable).toBe(false);
            expect(explanation.quality?.worst).toBe('freshness');
            expect(explanation.quality?.blockedBy).toEqual(['freshness']);
        });
    });

    it('agrees with itself when the market runs the other way', async () => {
        // A test that only ever sees a LONG is a test that cannot notice a
        // partition which is only correct for one of them.
        await withMarket(falling, ({ analysis, explanation }) => {
            expect(explanation.direction).toBe(analysis.signal.signal);
            expect(explanation.reason).toBe(analysis.signal.reason);

            for (const supporter of explanation.supporting) {
                expect(supporter.signal).toBe(explanation.direction);
            }
        });
    });
});
