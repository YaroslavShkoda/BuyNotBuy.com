import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market.js';

import type { HoldoutProtocol } from './holdout-protocol.js';
import {
    evaluateProtocol,
    isKnownMetric,
    METRIC_KEYS,
    protocolChanged,
    protocolFingerprint,
} from './holdout-protocol.js';
import type { Strategy } from './strategies.js';

const RISING: Candle[] = Array.from({ length: 60 }, (_, index) => {
    const close = 100 * 1.01 ** index;

    return {
        timestamp: 1_500_000_000_000 + index * 86_400_000,
        open: close,
        high: close * 1.005,
        low: close * 0.995,
        close,
        volume: 1,
    };
});

const protocol = (metrics: HoldoutProtocol['metrics']): HoldoutProtocol => ({
    metrics,
    registeredAt: 0,
    note: 'the whole question',
});

const alwaysLong: Strategy = {
    name: 'always-long',
    mechanism: 'Long on every bar, which is a benchmark and not a claim.',
    warmup: 0,
    decide: () => 1,
};

describe('the question is fixed before anyone can see the answer', () => {
    it('has a closed set of metrics, so a new statistic cannot be invented later', () => {
        // An open list would be a formality: anyone could add "sharpe" the
        // moment the return came out badly. This is the list.
        expect(METRIC_KEYS).toContain('totalReturn');
        expect(METRIC_KEYS).toContain('profitFactor');
        expect(isKnownMetric('sharpeRatio')).toBe(false);
        expect(isKnownMetric('totalReturn')).toBe(true);
    });

    it('moves its fingerprint when the question changes', () => {
        const before = protocol(['totalReturn']);
        const after = protocol(['profitFactor']);

        expect(protocolChanged(before, after)).toBe(true);
        expect(protocolChanged(before, protocol(['totalReturn']))).toBe(false);
    });

    it('does not move for a reordering, because a reordering asks the same thing', () => {
        // A fingerprint that moved for a reordering would cry wolf, and the
        // first person to see it would learn to ignore it.
        expect(
            protocolFingerprint(protocol(['totalReturn', 'trades'])),
        ).toBe(protocolFingerprint(protocol(['trades', 'totalReturn'])));
    });

    it('moves when the question is reworded, because that is how a question changes', () => {
        const before: HoldoutProtocol = { ...protocol(['totalReturn']), note: 'return' };
        const after: HoldoutProtocol = { ...protocol(['totalReturn']), note: 'return, honestly' };

        expect(protocolChanged(before, after)).toBe(true);
    });
});

describe('the verdict is the whole output, not the part that came out well', () => {
    it('reports every declared metric for every rule, with no argument to narrow it', () => {
        const verdicts = evaluateProtocol(
            protocol(['totalReturn', 'trades']),
            [
                { key: 'a', strategy: alwaysLong },
                { key: 'b', strategy: alwaysLong },
            ],
            RISING,
        );

        expect(verdicts).toHaveLength(2);
        for (const verdict of verdicts) {
            // Exactly the declared set — not fewer, and not more. A caller
            // cannot ask for the profitable one because there is nowhere to
            // put the preference.
            expect(Object.keys(verdict.readings).sort()).toEqual(['totalReturn', 'trades']);
        }
    });

    it('reports the same rule the same way twice, so a difference means something', () => {
        const first = evaluateProtocol(protocol(METRIC_KEYS), [{ key: 'a', strategy: alwaysLong }], RISING);
        const again = evaluateProtocol(protocol(METRIC_KEYS), [{ key: 'a', strategy: alwaysLong }], RISING);

        expect(again[0]?.readings).toEqual(first[0]?.readings);
    });

    it('carries every metric of the closed set when asked for all of them', () => {
        const verdict = evaluateProtocol(protocol(METRIC_KEYS), [{ key: 'a', strategy: alwaysLong }], RISING);

        expect(Object.keys(verdict[0]!.readings).sort()).toEqual([...METRIC_KEYS].sort());
    });

    it('reports a null rather than a number it does not have', () => {
        // Profit factor is undefined for a rule that never lost. Storing zero
        // would be a fabrication, and the record is the one place where a
        // fabricated zero would be believed.
        const verdict = evaluateProtocol(protocol(['profitFactor']), [{ key: 'a', strategy: alwaysLong }], RISING);

        expect(verdict[0]?.readings.profitFactor).toBeNull();
    });

    it('keys every verdict by the rule it belongs to', () => {
        const verdicts = evaluateProtocol(
            protocol(['trades']),
            [
                { key: 'first', strategy: alwaysLong },
                { key: 'second', strategy: alwaysLong },
            ],
            RISING,
        );

        expect(verdicts.map((verdict) => verdict.key)).toEqual(['first', 'second']);
    });
});
