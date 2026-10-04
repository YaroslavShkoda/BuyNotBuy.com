import { describe, expect, it } from 'vitest';
import type { SignalOutcome } from '../outcomes/outcome.js';
import { calibrate } from './calibration.js';
import type { PerformanceSample } from './performance.js';
import { groupBy } from './performance.js';
import { toPerformanceSamples } from './samples.js';

/**
 * The market identity is lost at the sample boundary, and PHASE 13 asks for an
 * asset cut that this cannot express.
 *
 * Measured, not suspected. `SignalOutcome` carries `symbol` — `resolveAtHorizon`
 * even puts it in its error message — and `toPerformanceSamples` copies
 * timestamp, direction, verdict, return, confidence, regime and indicators into
 * each sample and **drops the market**. Everything downstream
 * (`computeMetrics`, `confidenceBuckets`, `groupBy`, `byIndicator`,
 * `combinationValue`) then computes over a set that no longer knows which market
 * each row came from.
 *
 * The blend is latent rather than live: the only caller, `performance.cli.ts`,
 * loads one market (`WHERE o.symbol = $1`). That is exactly what makes it
 * dangerous — the single-market answer is currently guaranteed by the *caller*,
 * and nothing in the type says so. Add a second market and the report becomes a
 * calibration of two markets at once, with every individual number correct and
 * no question in it that the answer fails.
 *
 * `groupBy` already takes an arbitrary key, so the cut becomes one call away the
 * moment the sample knows its market — which is the whole content of this file.
 */

const HORIZON = { bars: 1, asOf: Number.MAX_SAFE_INTEGER, graceMs: 0 };

function outcomeFor(symbol: string, returnFraction: number): SignalOutcome {
    return {
        symbol,
        direction: 'LONG',
        entryTimestamp: 1_700_000_000_000,
        entryPrice: 100,
        horizons: [
            {
                bars: 1,
                verdict: returnFraction > 0 ? 'correct' : 'incorrect',
                returnFraction,
                maxFavourable: returnFraction,
                maxAdverse: returnFraction,
            },
        ],
        // Not read by anything in this file, and filled in because the type says
        // they exist. Written by hand rather than guessed at one field at a
        // time: three consecutive attempts to add only the field the compiler
        // complained about would have produced an object that satisfies the type
        // and describes nothing.
        closedBy: null,
    };
}

function samplesFor(...symbolAndReturn: readonly (readonly [string, number])[]) {
    const { samples } = toPerformanceSamples(
        symbolAndReturn.map(([symbol, value]) => ({
            outcome: outcomeFor(symbol, value),
            published: { confidence: 60 },
        })),
        HORIZON,
    );

    return samples;
}

describe('a performance sample knows which market it came from', () => {
    it('carries the symbol the outcome had', () => {
        const [sample] = samplesFor(['ETHUSDT', 0.02]);

        expect(sample).toBeDefined();
        expect(sample?.symbol).toBe('ETHUSDT');
    });

    it('and the asset cut is one call away', () => {
        const samples = samplesFor(['BTCUSDT', 0.02], ['ETHUSDT', -0.05]);

        const byMarket = groupBy(samples, (sample) => sample.symbol);

        // Without the field on the sample both markets land in one bucket, and
        // every number in it is true of a series nobody ran.
        expect([...byMarket.keys()].sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    });

    it('and a mixed set is distinguishable from a single-market one', () => {
        const mixed = samplesFor(['BTCUSDT', 0.02], ['ETHUSDT', -0.05]);
        const single = samplesFor(['BTCUSDT', 0.02]);

        const markets = (samples: readonly PerformanceSample[]) =>
            new Set(samples.map((sample) => sample.symbol));

        expect(markets(mixed).size).toBe(2);
        expect(markets(single).size).toBe(1);
    });
});

/**
 * The field is *required*, and that is pinned at the type rather than in a test.
 *
 * A runtime test cannot see it: making `symbol` optional changes nothing about
 * what `toPerformanceSamples` writes, so every case above still passed with the
 * field optional — a control confirmed exactly that. What optional would cost is
 * the pressure on everything that builds a sample later: four helpers in this
 * directory stopped compiling the moment the field was required, and each of
 * them had to say which market it was measuring.
 *
 * `@ts-expect-error` is the form that survives: if the field is ever made
 * optional, the directive has nothing to suppress and the build fails with
 * "unused '@ts-expect-error'". A comment saying the field is required would have
 * been the seventh assertion in this project that nothing can refute.
 */
describe('the sample type refuses a row without a market', () => {
    it('rejects a literal that omits the symbol', () => {
        const withoutMarket = {
            timestamp: 1_700_000_000_000,
            direction: 'LONG' as const,
            verdict: 'correct' as const,
            returnFraction: 0.02,
            confidence: 60,
        };

        // @ts-expect-error `symbol` is required: a measured row names its market
        const typed: PerformanceSample = withoutMarket;

        expect(typed.symbol).toBeUndefined();
    });
});

/**
 * A calibration report has to say which markets it measured.
 *
 * `calibrate` gathers every sample into one bucket keyed `'all'`, and that key
 * reaches a reader: the CLI prints the calibration's score and its mean claimed
 * confidence under the heading "Калибровка: сколько заявляли и сколько сбылось"
 * without ever naming a market. With one market that is a missing label; with two
 * it is a calibration of both presented under one set of numbers, and every
 * number in it is true.
 *
 * Refusing the blend is not the fix — PHASE 44 asks for a portfolio-shaped
 * aggregate eventually, and that is a legitimate question. The fix is that the
 * answer names its own scope, so the question asked is legible in the answer.
 */
describe('a calibration report names its scope', () => {
    it('names the single market it measured', () => {
        const report = calibrate(samplesFor(['BTCUSDT', 0.02], ['BTCUSDT', 0.01]));

        expect((report as unknown as { scope?: string }).scope).toBe('BTCUSDT');
    });

    it('names every market when the set is mixed', () => {
        const report = calibrate(samplesFor(['ETHUSDT', 0.02], ['BTCUSDT', 0.01]));

        expect((report as unknown as { scope?: string }).scope).toBe(
            'BTCUSDT, ETHUSDT',
        );
    });

    it('and says so when there is nothing measured', () => {
        const report = calibrate([]);

        expect((report as unknown as { scope?: string }).scope).toBeNull();
    });
});
