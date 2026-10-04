import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ConfidenceModel } from '../config/consensus.config.js';
import { consensusConfig } from '../config/consensus.config.js';
import {
    calculateConsensus,
    describeSignal,
    partitionPanel,
} from './consensus.js';
import { explainSignal } from './explanation.js';
import type { IndicatorAnalysis } from './signal.types.js';

const NAMES = ['A', 'B', 'C'] as const;

function vote(
    index: number,
    signal: 'LONG' | 'SHORT' | 'NEUTRAL',
    weight: number,
    reason = `${NAMES[index] ?? `I${index}`} says something`,
): IndicatorAnalysis {
    return {
        key: NAMES[index]?.toLowerCase() as IndicatorAnalysis['key'],
        name: NAMES[index] ?? `I${index}`,
        signal,
        reason,
        weight,
    };
}

const REGIME = {
    volatility: 'NORMAL',
    trend: 'TREND_UP',
    unreliable: null,
};

const GOOD_QUALITY = {
    score: 0.9,
    usable: true,
    worst: 'freshness',
    blockedBy: [],
};

const BAD_QUALITY = {
    score: 0.2,
    usable: false,
    worst: 'gaps',
    blockedBy: ['gaps'],
};

describe('the panel behind a verdict', () => {
    it('splits the indicators three ways, and loses nobody', () => {
        const panel = [
            vote(0, 'LONG', 0.9),
            vote(1, 'LONG', 0.7),
            vote(2, 'SHORT', 0.5),
        ];
        const split = partitionPanel(panel, 'LONG');

        expect(split.supporting.map((a) => a.name)).toEqual(['A', 'B']);
        expect(split.opposing.map((a) => a.name)).toEqual(['C']);
        expect(split.abstaining).toEqual([]);
        expect(
            split.supporting.length + split.opposing.length + split.abstaining.length,
        ).toBe(panel.length);
    });

    it('puts abstentions in neither side', () => {
        // NEUTRAL means "no opinion". Counting it as opposition would turn a
        // panel that agreed into a panel that disagreed with a dissenter.
        const split = partitionPanel(
            [vote(0, 'LONG', 0.9), vote(1, 'LONG', 0.8), vote(2, 'NEUTRAL', 0.4)],
            'LONG',
        );

        expect(split.supporting).toHaveLength(2);
        expect(split.opposing).toHaveLength(0);
        expect(split.abstaining).toHaveLength(1);
    });

    it('has nobody on either side when nothing was published', () => {
        const split = partitionPanel([vote(0, 'LONG', 0.9)], 'NEUTRAL');

        expect(split.supporting).toEqual([]);
        expect(split.opposing).toEqual([]);
    });
});

describe('the reason and the structure cannot disagree', () => {
    it('generates the dashboard sentence from the same partition', () => {
        const panel = [vote(0, 'LONG', 0.9), vote(1, 'LONG', 0.8), vote(2, 'SHORT', 0.5)];
        const verdict = calculateConsensus(panel);
        const explanation = explainSignal({
            direction: verdict.signal,
            confidence: verdict.confidence,
            confidenceModel: consensusConfig.confidenceModel,
            analyses: panel,
            reason: verdict.reason,
        });

        // One function renders the sentence, over one partition. There is no
        // second place for the two to drift apart.
        expect(explanation.reason).toBe(verdict.reason);
        expect(explanation.reason).toBe(
            describeSignal(partitionPanel(panel, verdict.signal), verdict.signal, verdict.reason),
        );
    });

    it('keeps the fallback reason for a verdict that was never published', () => {
        // "Barely confirms" describes a failure to publish, not a panel that
        // did, so it must survive a round trip through the structure.
        const panel = [vote(0, 'LONG', 0.2), vote(1, 'LONG', 0.2)];
        const verdict = calculateConsensus(panel);

        expect(verdict.signal).toBe('NEUTRAL');
        expect(verdict.reason).toMatch(/едва подтверждают/);

        const explanation = explainSignal({
            direction: verdict.signal,
            confidence: verdict.confidence,
            confidenceModel: consensusConfig.confidenceModel,
            analyses: panel,
            reason: verdict.reason,
        });

        expect(explanation.reason).toBe(verdict.reason);
    });

    it('says the same thing for a hundred random panels', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.record({
                        signal: fc.constantFrom(
                            'LONG' as const,
                            'SHORT' as const,
                            'NEUTRAL' as const,
                        ),
                        weight: fc.double({ min: 0, max: 1, noNaN: true }),
                    }),
                    { minLength: 1, maxLength: 6 },
                ),
                (votes) => {
                    const panel = votes.map((entry, index) =>
                        vote(index % 3, entry.signal, entry.weight),
                    );
                    const verdict = calculateConsensus(panel);
                    const explanation = explainSignal({
                        direction: verdict.signal,
                        confidence: verdict.confidence,
                        confidenceModel: consensusConfig.confidenceModel,
                        analyses: panel,
                        reason: verdict.reason,
                    });

                    expect(explanation.reason).toBe(verdict.reason);
                },
            ),
            { numRuns: 200 },
        );
    });
});

describe('what moved the number', () => {
    const panel = [
        vote(0, 'LONG', 0.8, 'EMA is far below price'),
        vote(1, 'LONG', 0.4, 'Stochastic crossed up'),
        vote(2, 'SHORT', 0.2, 'Momentum is mildly negative'),
    ];

    it('adds up to the share the confidence was computed from', () => {
        const verdict = calculateConsensus(panel);
        const explanation = explainSignal({
            direction: verdict.signal,
            confidence: verdict.confidence,
            confidenceModel: consensusConfig.confidenceModel,
            analyses: panel,
            reason: verdict.reason,
        });

        const supporting = explanation.factors
            .filter((factor) => factor.stance === 'supporting')
            .reduce((sum, factor) => sum + factor.impact, 0);

        // 0.8 and 0.4 against a total weight of 1.4: 85.71% of the weight is on
        // the published side, and that is the figure the confidence was
        // computed from. A list of factors a reader cannot add up to the number
        // they are explaining is a list of impressions.
        expect(supporting).toBeCloseTo(85.71, 1);
    });

    it('still shows the dissent, and the signed total is the net share', () => {
        const explanation = explainSignal({
            direction: 'LONG',
            confidence: 79,
            confidenceModel: 'wilson',
            analyses: panel,
            reason: 'x',
        });

        const total = explanation.factors.reduce(
            (sum, factor) => sum + factor.impact,
            0,
        );

        // 85.71 for the pair minus 14.29 for the vote against. The confidence
        // comes from the gross share, not this one, which is why the two are
        // reported separately rather than as one number.
        expect(total).toBeCloseTo(71.43, 1);
    });

    it('reports a confidence at or below the share its supporters add up to', () => {
        const verdict = calculateConsensus(panel);
        const explanation = explainSignal({
            direction: verdict.signal,
            confidence: verdict.confidence,
            confidenceModel: 'wilson',
            analyses: panel,
            reason: verdict.reason,
        });

        const share = explanation.factors
            .filter((factor) => factor.stance === 'supporting')
            .reduce((sum, factor) => sum + factor.impact, 0);

        // Wilson is the pessimistic end, so it is always at or below the
        // observed share. A confidence above it would mean one of the two was
        // wrong, and a reader would have no way of telling which.
        expect(explanation.confidence.value).toBeLessThanOrEqual(share);
    });

    it('orders them by how much each one mattered', () => {
        const explanation = explainSignal({
            direction: 'LONG',
            confidence: 70,
            confidenceModel: 'wilson',
            analyses: panel,
            reason: 'x',
        });

        const impacts = explanation.factors.map((factor) =>
            Math.abs(factor.impact),
        );

        expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    });

    it('shows a vote against the direction as a negative share', () => {
        const explanation = explainSignal({
            direction: 'LONG',
            confidence: 70,
            confidenceModel: 'wilson',
            analyses: panel,
            reason: 'x',
        });

        const opposing = explanation.factors.find((f) => f.stance === 'opposing');

        expect(opposing?.impact).toBeLessThan(0);
        expect(opposing?.detail).toBe('Momentum is mildly negative');
    });

    it('has no factors for a signal that was not published', () => {
        const explanation = explainSignal({
            direction: 'NEUTRAL',
            confidence: 0,
            confidenceModel: 'wilson',
            analyses: panel,
            reason: 'Индикаторы дают противоположные сигналы',
        });

        // There is no explanation of a signal that does not exist, and an
        // empty list is more honest than a list of factors that did not add up
        // to it.
        expect(explanation.factors).toEqual([]);
    });

    it('keeps the data quality out of the arithmetic but not out of the account', () => {
        const explanation = explainSignal({
            direction: 'LONG',
            confidence: 70,
            confidenceModel: 'wilson',
            analyses: panel,
            reason: 'x',
            quality: BAD_QUALITY,
        });

        const quality = explanation.factors.find(
            (factor) => factor.key === 'dataQuality',
        );

        // A bad series is a reason the panel might be wrong, not a vote against
        // it. Adding it to the sum would be arithmetic about a thing the sum
        // does not measure; leaving it out entirely would hide it.
        expect(quality?.impact).toBe(0);
        expect(quality?.stance).toBe('opposing');
        expect(quality?.detail).toContain('gaps');
    });

    it('names a healthy series too', () => {
        const explanation = explainSignal({
            direction: 'LONG',
            confidence: 70,
            confidenceModel: 'wilson',
            analyses: panel,
            reason: 'x',
            quality: GOOD_QUALITY,
        });

        const quality = explanation.factors.find(
            (factor) => factor.key === 'dataQuality',
        );

        expect(quality?.stance).toBe('supporting');
        expect(quality?.impact).toBe(0);
    });
});

describe('what confidence means', () => {
    const models: ConfidenceModel[] = ['wilson', 'share', 'mean_conviction'];

    it('never claims to be a probability, under any model', () => {
        for (const model of models) {
            const explanation = explainSignal({
                direction: 'LONG',
                confidence: 71,
                confidenceModel: model,
                analyses: [vote(0, 'LONG', 0.9), vote(1, 'LONG', 0.8)],
                reason: 'x',
            });

            // The field is typed `false`, so it cannot become true without a
            // type error. The string is the part a person actually reads.
            expect(explanation.confidence.isProbabilityOfBeingRight).toBe(false);
            expect(explanation.confidence.meaning).toContain(
                'Не вероятность',
            );
        }
    });

    it('says something different for each model, because each answers differently', () => {
        const meanings = models.map(
            (model) =>
                explainSignal({
                    direction: 'LONG',
                    confidence: 71,
                    confidenceModel: model,
                    analyses: [vote(0, 'LONG', 0.9)],
                    reason: 'x',
                }).confidence.meaning,
        );

        expect(new Set(meanings).size).toBe(models.length);
    });

    it('reports the value and the model together', () => {
        const explanation = explainSignal({
            direction: 'LONG',
            confidence: 71,
            confidenceModel: 'wilson',
            analyses: [vote(0, 'LONG', 0.9)],
            reason: 'x',
        });

        expect(explanation.confidence.value).toBe(71);
        expect(explanation.confidence.model).toBe('wilson');
    });
});

describe('the market the signal was given in', () => {
    const panel = [vote(0, 'LONG', 0.9), vote(1, 'LONG', 0.8)];

    it('carries the regime through, including why it may not be trusted', () => {
        // A regime label computed from forty bars does not read the same as one
        // computed from eight hundred, and dropping the caveat would make them
        // indistinguishable.
        const explanation = explainSignal({
            direction: 'LONG',
            confidence: 70,
            confidenceModel: 'wilson',
            analyses: panel,
            reason: 'x',
            regime: { ...REGIME, unreliable: 'fewer than 50 bars' },
        });

        expect(explanation.regime?.unreliable).toBe('fewer than 50 bars');
        expect(explanation.regime?.trend).toBe('TREND_UP');
    });

    it('carries no regime when none was computed, rather than inventing one', () => {
        const explanation = explainSignal({
            direction: 'LONG',
            confidence: 70,
            confidenceModel: 'wilson',
            analyses: panel,
            reason: 'x',
        });

        expect(explanation.regime).toBeNull();
        expect(explanation.quality).toBeNull();
    });
});
