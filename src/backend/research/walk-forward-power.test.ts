import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market.js';
import type { Strategy } from './strategies.js';
import type { RuleProfile } from './walk-forward-power.js';
import {
    compareAgainstCoins,
    EXPOSURE_TOLERANCE,
    measureExposure,
    SIGNIFICANCE_LEVEL,
} from './walk-forward-power.js';

const day = 86_400_000;
const base = Date.UTC(2021, 0, 1);

const SERIES: Candle[] = Array.from({ length: 400 }, (_, index) => {
    const close = 100 + (index % 2 === 0 ? 0.1 : -0.1);

    return {
        timestamp: base + index * day,
        open: close,
        high: close * 1.005,
        low: close * 0.995,
        close,
        volume: 1,
    };
});

const profile = (over: Partial<RuleProfile> = {}): RuleProfile => ({
    key: 'rule',
    exposure: 0.3,
    profitableShare: 0.5,
    worstFold: -0.1,
    bestFold: 0.2,
    folds: 8,
    trades: 40,
    ...over,
});

describe('coins are only comparable when they trade as often', () => {
    it('leaves out the coins whose frequency is nothing like the rule', () => {
        // The clause the whole design rests on, and the one missing from every
        // earlier comparison here. A rule in the market 10% of the time and a
        // coin in it 50% are not comparable on fold share, profit factor or
        // anything else walk-forward produces.
        const result = compareAgainstCoins(
            profile({ exposure: 0.1 }),
            [
                profile({ exposure: 0.1 }),
                profile({ exposure: 0.15 }),
                profile({ exposure: 0.4 }),
                profile({ exposure: 0.5 }),
            ],
        );

        expect(result.matchedCoins).toBe(2);
    });

    it('counts the tolerance as a distance, not a multiple', () => {
        const near = profile({ exposure: 0.3 + EXPOSURE_TOLERANCE - 0.001 });
        const far = profile({ exposure: 0.3 + EXPOSURE_TOLERANCE + 0.001 });

        expect(compareAgainstCoins(profile(), [near]).matchedCoins).toBe(1);
        expect(compareAgainstCoins(profile(), [far]).matchedCoins).toBe(0);
    });

    it('measures the trading frequency of a rule rather than believing it', () => {
        const everyThird: Strategy = {
            name: 'every-third',
            mechanism: 'Long on every third bar, which is a schedule and not a claim.',
            warmup: 0,
            decide: ({ index }) => (index % 3 === 0 ? 1 : 0),
        };

        expect(measureExposure(everyThird, SERIES)).toBeCloseTo(1 / 3, 2);
    });

    it('reports a rule that never trades as zero exposure, not as a failure', () => {
        const never: Strategy = {
            name: 'never',
            mechanism: 'Never takes a position.',
            warmup: 0,
            decide: () => 0,
        };

        expect(measureExposure(never, SERIES)).toBe(0);
    });
});

describe('a rule is significant when it beats the coins that match it', () => {
    it('passes when almost no coin reaches its fold share', () => {
        const result = compareAgainstCoins(
            profile({ profitableShare: 0.875 }),
            Array.from({ length: 20 }, () => profile({ profitableShare: 0.5 })),
        );

        expect(result.significant).toBe(true);
        expect(result.pValue).toBe(0);
    });

    it('fails when it ties with the typical coin', () => {
        // Ties count against it. A rule that is no better than a coin has not
        // demonstrated anything, and treating "equal" as "not worse" is how a
        // criterion stops being one.
        const result = compareAgainstCoins(
            profile({ profitableShare: 0.5 }),
            Array.from({ length: 10 }, () => profile({ profitableShare: 0.5 })),
        );

        expect(result.pValue).toBe(1);
        expect(result.significant).toBe(false);
    });

    it('fails when it is beaten, which is the ordinary case', () => {
        const result = compareAgainstCoins(
            profile({ profitableShare: 0.25 }),
            Array.from({ length: 10 }, () => profile({ profitableShare: 0.5 })),
        );

        expect(result.pValue).toBe(1);
    });

    it('stays silent rather than confident when nothing matched', () => {
        // A percentile over four coins is not a percentile, and a rule with no
        // comparable peers must not be handed a p-value that reads like one.
        const result = compareAgainstCoins(
            profile({ exposure: 0.05 }),
            [profile({ exposure: 0.5 })],
        );

        expect(result.matchedCoins).toBe(0);
        expect(result.pValue).toBe(1);
        expect(result.significant).toBe(false);
        expect(Number.isNaN(result.bestCoinShare)).toBe(true);
    });

    it('reports the resolution the population allows', () => {
        // With 80 coins one coin is 1.25% of a percentile, so a p-value of
        // 0.050 has a resolution of about ±0.0125 and cannot be read to three
        // places. This is why the real measurement reports how many were
        // matched rather than only the p it produced.
        const coins = Array.from({ length: 80 }, () =>
            profile({ profitableShare: 0.5, exposure: 0.3 }),
        );
        const result = compareAgainstCoins(
            profile({ profitableShare: 0.625, exposure: 0.3 }),
            coins,
        );

        expect(result.matchedCoins).toBe(80);
        // Every coin trails the rule, so the p is the floor: no coin qualified.
        expect(result.pValue).toBe(0);
        expect(result.significant).toBe(true);
    });

    it('moves the p by exactly one coin when one more qualifies', () => {
        const coins = Array.from({ length: 80 }, (_, index) =>
            profile({ profitableShare: index < 4 ? 0.625 : 0.5, exposure: 0.3 }),
        );
        const result = compareAgainstCoins(
            profile({ profitableShare: 0.625, exposure: 0.3 }),
            coins,
        );

        // 4 of 80 — the resolution claim above, made concrete.
        expect(result.pValue).toBeCloseTo(0.05, 12);
    });
});

describe('the level itself is a choice, and says so', () => {
    it('is the conventional five per cent', () => {
        expect(SIGNIFICANCE_LEVEL).toBe(0.05);
    });

    it('is strict at the boundary, and says which side a tie falls on', () => {
        // volatility-trend came out at exactly 0.050. Reading a tie as a pass
        // would move the answer on a coin count, so the comparison is strict
        // and the rule that decides it is visible in the signature.
        const coins = Array.from({ length: 20 }, (_, index) =>
            profile({ profitableShare: index === 0 ? 0.75 : 0.5 }),
        );
        const exact = compareAgainstCoins(profile({ profitableShare: 0.75 }), coins, 0.05);

        // 1 of 20 coins reaches 0.75, so p is exactly 0.05 — and exactly on the
        // line does not count as under it.
        expect(exact.pValue).toBeCloseTo(0.05, 12);
        expect(exact.significant).toBe(false);
    });
});
