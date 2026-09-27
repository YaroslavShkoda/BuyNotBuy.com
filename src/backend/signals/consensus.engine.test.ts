import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { calculateConsensus, wilsonLowerBound } from './consensus.js';
import {
    ConsensusConfigParser,
    consensusConfig,
} from '../config/consensus.config.js';

import type { IndicatorAnalysis, SignalResult } from './signal.types.js';
import type { ConsensusConfig } from '../config/consensus.config.js';

const NAMES = ['A', 'B', 'C'] as const;

function vote(
    index: number,
    signal: 'LONG' | 'SHORT' | 'NEUTRAL',
    weight: number,
): IndicatorAnalysis {
    return {
        key: NAMES[index]?.toLowerCase() as IndicatorAnalysis['key'],
        name: NAMES[index] ?? `I${index}`,
        signal,
        reason: '',
        weight,
    };
}

/**
 * The consensus as it was before it became configurable.
 *
 * Written out again rather than imported, and that is the point: an
 * equivalence test that calls the implementation it is testing proves nothing
 * at all. This is the original arithmetic, transcribed, with the three
 * constants it used written into its body so there is nowhere for a shared
 * change to hide.
 */
function legacyConsensus(
    analyses: readonly IndicatorAnalysis[],
): Omit<SignalResult, 'indicators'> {
    const clamp = (value: number): number =>
        Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

    const legacyTally = (
        signal: 'LONG' | 'SHORT',
    ): { count: number; weight: number } => {
        let count = 0;
        let weight = 0;

        for (const analysis of analyses) {
            if (analysis.signal === signal) {
                count += 1;
                weight += clamp(analysis.weight);
            }
        }

        return { count, weight };
    };

    const long = legacyTally('LONG');
    const short = legacyTally('SHORT');
    const neutralCount = analyses.filter(
        (analysis) => analysis.signal === 'NEUTRAL',
    ).length;
    const totalWeight = long.weight + short.weight;

    const join = (names: string[]): string =>
        names.length <= 1
            ? (names[0] ?? '')
            : `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`;

    if (long.count === short.count) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason:
                long.count > 0
                    ? 'Индикаторы дают противоположные сигналы'
                    : 'Ни один индикатор не даёт сигнала',
        };
    }

    const winningSignal = long.count > short.count ? 'LONG' : 'SHORT';
    const winning = winningSignal === 'LONG' ? long : short;
    const losing = winningSignal === 'LONG' ? short : long;
    const winningNames = analyses
        .filter((analysis) => analysis.signal === winningSignal)
        .map((analysis) => analysis.name);

    if (winning.count < 2) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason: `Нет большинства: только ${join(winningNames)} за ${winningSignal}`,
        };
    }

    if (totalWeight <= 0) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason: 'Ни один индикатор не даёт сигнала',
        };
    }

    const meanConviction = winning.weight / winning.count;

    if (meanConviction < 0.25) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason: `${join(winningNames)} едва подтверждают ${winningSignal}`,
        };
    }

    const confidence = Math.round(
        wilsonLowerBound(winning.weight * 100, totalWeight * 100) * 100,
    );
    const verb = winning.count === 1 ? 'подтверждает' : 'подтверждают';
    const only = neutralCount > 0 && losing.count === 0 ? 'Только ' : '';

    return {
        signal: winningSignal,
        confidence,
        reason: `${only}${join(winningNames)} ${verb} ${winningSignal}`,
    };
}

/** Every signal a panel of three can produce, at a set of weights. */
function allPanels(): IndicatorAnalysis[][] {
    const signals = ['LONG', 'SHORT', 'NEUTRAL'] as const;
    const weights = [0, 0.1, 0.24, 0.25, 0.26, 0.5, 0.9, 1, 1.5, -0.4, Number.NaN];
    const panels: IndicatorAnalysis[][] = [];

    for (const a of signals) {
        for (const b of signals) {
            for (const c of signals) {
                for (const wa of weights) {
                    for (const wb of weights) {
                        for (const wc of weights) {
                            panels.push([
                                vote(0, a, wa),
                                vote(1, b, wb),
                                vote(2, c, wc),
                            ]);
                        }
                    }
                }
            }
        }
    }

    return panels;
}

describe('the defaults have not changed', () => {
    it('are the settings the original engine used', () => {
        expect(consensusConfig).toEqual({
            minimumAgreeing: 2,
            minimumMeanConviction: 0.25,
            weightModel: 'continuous',
            confidenceModel: 'wilson',
        });
    });

    it('produce the original answer on every reachable panel', () => {
        const panels = allPanels();
        const differing: string[] = [];

        for (const panel of panels) {
            const expected = legacyConsensus(panel);
            const actual = calculateConsensus(panel);

            if (
                actual.signal !== expected.signal ||
                actual.confidence !== expected.confidence ||
                actual.reason !== expected.reason
            ) {
                differing.push(
                    JSON.stringify({
                        panel: panel.map((p) => [p.signal, p.weight]),
                        expected,
                        actual,
                    }),
                );
            }
        }

        // 12 000-odd panels: every combination of three votes with eleven
        // weights each, including weights outside the range and one that is
        // not a number. If one line of the refactor had shifted a constant,
        // this is where it would show.
        expect(panels.length).toBeGreaterThan(10_000);
        expect(differing).toEqual([]);
    });

    it('produce the original answer on an empty and a single-indicator panel', () => {
        for (const panel of [
            [],
            [vote(0, 'LONG', 1)],
            [vote(0, 'NEUTRAL', 1)],
            [vote(0, 'SHORT', 0.9)],
        ]) {
            expect(calculateConsensus(panel)).toEqual(legacyConsensus(panel));
        }
    });

    it('produce the original answer on a larger panel', () => {
        // The engine is not written for three and must not behave differently
        // at five, where "a majority" stops meaning what it meant at three.
        const panel = [
            vote(0, 'LONG', 0.8),
            vote(1, 'LONG', 0.6),
            vote(2, 'SHORT', 0.9),
            vote(3, 'NEUTRAL', 0),
            vote(4, 'LONG', 0.3),
        ];

        expect(calculateConsensus(panel)).toEqual(legacyConsensus(panel));
    });
});

describe('agreement floor', () => {
    const panel = [
        vote(0, 'LONG', 0.9),
        vote(1, 'LONG', 0.8),
        vote(2, 'SHORT', 0.7),
    ];

    it('publishes at the configured number of agreeing indicators', () => {
        const raised = calculateConsensus(panel, {
            ...consensusConfig,
            minimumAgreeing: 3,
        });

        // Two are not enough when the setting says three, and the reason says
        // so rather than reporting a bare zero.
        expect(raised.signal).toBe('NEUTRAL');
        expect(raised.reason).toMatch(/Нет большинства/);
    });

    it('can be lowered to let a single indicator through, and says it is not a consensus', () => {
        const lowered = calculateConsensus([vote(0, 'LONG', 0.9)], {
            ...consensusConfig,
            minimumAgreeing: 1,
        });

        expect(lowered.signal).toBe('LONG');
        expect(lowered.reason).toContain('A подтверждает LONG');
    });

    it('is applied to count, not to weight', () => {
        // Three votes that cleared their own thresholds but cleared the
        // conviction one by a hair. The count passes; the floor is what stops
        // it, and the reason says which one stopped it.
        const weak = calculateConsensus(
            [
                vote(0, 'LONG', 0.2),
                vote(1, 'LONG', 0.2),
                vote(2, 'LONG', 0.2),
            ],
            { ...consensusConfig, minimumAgreeing: 2 },
        );

        expect(weak.signal).toBe('NEUTRAL');
        expect(weak.reason).toMatch(/едва подтверждают/);
    });

    it('does not let a decisive minority through on weight', () => {
        // One emphatic vote against two faint ones loses on the count, which is
        // the floor. The count and the weight are two different questions, and
        // a setting that quietly mixed them would not know what it was asking.
        const decisive = calculateConsensus(
            [vote(0, 'LONG', 1), vote(1, 'SHORT', 0.3), vote(2, 'SHORT', 0.3)],
            { ...consensusConfig, minimumAgreeing: 2 },
        );

        expect(decisive.signal).toBe('SHORT');
    });

    it('is the count, not the weight, that makes a minority a minority', () => {
        // One vote, however emphatic, is an opinion. Raising the floor to three
        // on a panel of three shows the check is on the count alone: no weight
        // available to this panel can reach it.
        const unanimous = [vote(0, 'LONG', 1), vote(1, 'LONG', 1), vote(2, 'LONG', 1)];

        expect(calculateConsensus(unanimous).signal).toBe('LONG');
        expect(
            calculateConsensus(unanimous, {
                ...consensusConfig,
                minimumAgreeing: 4,
            }).signal,
        ).toBe('NEUTRAL');
    });
});

describe('conviction floor', () => {
    const panel = [
        vote(0, 'LONG', 0.4),
        vote(1, 'LONG', 0.4),
    ];

    it('publishes a panel that clears it', () => {
        expect(
            calculateConsensus(panel, {
                ...consensusConfig,
                minimumMeanConviction: 0.3,
            }).signal,
        ).toBe('LONG');
    });

    it('withholds a panel that does not, and says it is a near miss', () => {
        const withheld = calculateConsensus(panel, {
            ...consensusConfig,
            minimumMeanConviction: 0.5,
        });

        expect(withheld.signal).toBe('NEUTRAL');
        expect(withheld.reason).toMatch(/едва подтверждают/);
    });

    it('can be switched off, and then a bare majority publishes', () => {
        const open = calculateConsensus(
            [vote(0, 'LONG', 0.01), vote(1, 'LONG', 0.01)],
            { ...consensusConfig, minimumMeanConviction: 0 },
        );

        expect(open.signal).toBe('LONG');
    });
});

describe('weight model', () => {
    it('stops caring how strong a vote was when told to count them equally', () => {
        const barely = [vote(0, 'LONG', 0.26), vote(1, 'LONG', 0.26), vote(2, 'SHORT', 0.9)];
        const decisively = [vote(0, 'LONG', 1), vote(1, 'LONG', 1), vote(2, 'SHORT', 0.9)];
        const binary = { ...consensusConfig, weightModel: 'binary' as const };

        // The same directions, wildly different strengths, and the model
        // reports them identically. That is what it is for and what it costs:
        // the number stops moving with conviction, so a panel that scraped past
        // its thresholds and a panel that was emphatic become indistinguishable
        // in the published confidence.
        expect(calculateConsensus(barely, binary).confidence).toBe(
            calculateConsensus(decisively, binary).confidence,
        );

        // The continuous model does keep them apart, which is why it is the
        // default rather than the simpler one.
        expect(
            calculateConsensus(barely).confidence,
        ).toBeLessThan(calculateConsensus(decisively).confidence);
    });

    it('can raise a confidence the continuous model reported low', () => {
        const panel = [vote(0, 'LONG', 1), vote(1, 'LONG', 0.3), vote(2, 'SHORT', 0.9)];

        // A weak vote on the winning side gains from being promoted to a full
        // vote. Not a bug, and the reason binary is not the default: the
        // direction of the move depends on which side the weak vote was on.
        expect(
            calculateConsensus(panel, {
                ...consensusConfig,
                weightModel: 'binary',
            }).confidence,
        ).toBeGreaterThan(calculateConsensus(panel).confidence);
    });

    it('keeps a strong vote from dominating a panel under the square root', () => {
        const sqrt = calculateConsensus(
            [vote(0, 'LONG', 1), vote(1, 'LONG', 0.3), vote(2, 'SHORT', 1)],
            { ...consensusConfig, weightModel: 'sqrt' },
        );
        const continuous = calculateConsensus(
            [vote(0, 'LONG', 1), vote(1, 'LONG', 0.3), vote(2, 'SHORT', 1)],
        );

        // Monotonic but damped: a vote four times as strong is worth two times
        // as much, not four.
        expect(sqrt.signal).toBe('LONG');
        expect(sqrt.confidence).toBeGreaterThan(continuous.confidence);
    });

    it('never makes a strong vote worth less than a weak one, in any model', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('continuous', 'binary', 'sqrt' as const),
                fc.double({ min: 0, max: 1, noNaN: true }),
                fc.double({ min: 0, max: 1, noNaN: true }),
                (model, weak, strong) => {
                    const ordered = Math.max(weak, strong);
                    const lesser = Math.min(weak, strong);

                    const a = calculateConsensus(
                        [vote(0, 'LONG', ordered), vote(1, 'LONG', 0.5)],
                        { ...consensusConfig, weightModel: model },
                    );
                    const b = calculateConsensus(
                        [vote(0, 'LONG', lesser), vote(1, 'LONG', 0.5)],
                        { ...consensusConfig, weightModel: model },
                    );

                    // The one property that must hold whatever the setting: the
                    // panel can still tell a decisive indicator from a
                    // marginal one.
                    expect(a.confidence).toBeGreaterThanOrEqual(b.confidence);
                },
            ),
            { numRuns: 300 },
        );
    });

    it('still excludes an abstaining indicator, in every model', () => {
        for (const model of ['continuous', 'binary', 'sqrt'] as const) {
            const withAbstention = calculateConsensus(
                [
                    vote(0, 'LONG', 0.9),
                    vote(1, 'LONG', 0.9),
                    vote(2, 'NEUTRAL', 1),
                ],
                { ...consensusConfig, weightModel: model },
            );
            const alone = calculateConsensus(
                [vote(0, 'LONG', 0.9), vote(1, 'LONG', 0.9)],
                { ...consensusConfig, weightModel: model },
            );

            expect(withAbstention.confidence).toBe(alone.confidence);
        }
    });
});

describe('confidence model', () => {
    const split = [
        vote(0, 'LONG', 0.9),
        vote(1, 'LONG', 0.9),
        vote(2, 'SHORT', 0.9),
    ];

    it('reports the pessimistic end by default, not the raw share', () => {
        const wilson = calculateConsensus(split);
        const share = calculateConsensus(split, {
            ...consensusConfig,
            confidenceModel: 'share',
        });

        // Two to one is 67% of the weight and, as a certainty, it is not.
        // The share model is not wrong arithmetically, it is answering a
        // different question, and the default answers the one a trader is
        // asking.
        expect(share.confidence).toBe(67);
        expect(wilson.confidence).toBeLessThan(share.confidence);
    });

    it('reports the panel strength when told to mean conviction', () => {
        const mean = calculateConsensus(split, {
            ...consensusConfig,
            confidenceModel: 'mean_conviction',
        });

        // The share model and the conviction model disagree on this panel, and
        // the gap is the point: two-to-one by strength is not two-to-one in
        // count, and neither number describes both.
        expect(mean.confidence).toBe(90);
        expect(mean.confidence).not.toBe(
            calculateConsensus(split, {
                ...consensusConfig,
                confidenceModel: 'share',
            }).confidence,
        );
    });

    it('reports zero for a panel that published nothing, in every model', () => {
        for (const model of ['wilson', 'share', 'mean_conviction'] as const) {
            expect(
                calculateConsensus([vote(0, 'NEUTRAL', 0.9)], {
                    ...consensusConfig,
                    confidenceModel: model,
                }),
            ).toMatchObject({ signal: 'NEUTRAL', confidence: 0 });
        }
    });

    it('keeps every reported confidence inside 0..100', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('wilson', 'share', 'mean_conviction' as const),
                fc.array(
                    fc.record({
                        signal: fc.constantFrom(
                            'LONG' as const,
                            'SHORT' as const,
                            'NEUTRAL' as const,
                        ),
                        weight: fc.double({
                            min: 0,
                            max: 1,
                            noNaN: true,
                        }),
                    }),
                    { minLength: 1, maxLength: 8 },
                ),
                (model, votes) => {
                    const panel = votes.map((entry, index) =>
                        vote(index, entry.signal, entry.weight),
                    );
                    const result = calculateConsensus(panel, {
                        ...consensusConfig,
                        confidenceModel: model,
                    });

                    expect(result.confidence).toBeGreaterThanOrEqual(0);
                    expect(result.confidence).toBeLessThanOrEqual(100);
                    expect(Number.isInteger(result.confidence)).toBe(true);
                },
            ),
            { numRuns: 300 },
        );
    });
});

describe('configuration is validated rather than trusted', () => {
    const valid: ConsensusConfig = {
        minimumAgreeing: 2,
        minimumMeanConviction: 0.25,
        weightModel: 'continuous',
        confidenceModel: 'wilson',
    };

    it('accepts the shipped defaults', () => {
        expect(
            ConsensusConfigParser.parse({
                minimumAgreeing: '2',
                minimumMeanConviction: '0.25',
                weightModel: 'continuous',
                confidenceModel: 'wilson',
            }),
        ).toEqual(consensusConfig);
    });

    it('rejects a threshold that can never be met by any indicator', () => {
        expect(() =>
            parseConsensus({ minimumAgreeing: 0 }),
        ).toThrow();
        expect(() => parseConsensus({ minimumAgreeing: -1 })).toThrow();
    });

    it('rejects a conviction floor outside the range weights live in', () => {
        expect(() => parseConsensus({ minimumMeanConviction: 1.5 })).toThrow();
        expect(() => parseConsensus({ minimumMeanConviction: -0.1 })).toThrow();
    });

    it('rejects a model it does not have an implementation for', () => {
        expect(() =>
            parseConsensus({ weightModel: 'majority' }),
        ).toThrow();
    });

    it('rejects a configuration with neither floor', () => {
        expect(() =>
            parseConsensus({
                minimumAgreeing: 1,
                minimumMeanConviction: 0,
            }),
        ).toThrow(/first vote/);
    });

    it('accepts every valid combination of the four settings', () => {
        for (const weightModel of ['continuous', 'binary', 'sqrt']) {
            for (const confidenceModel of [
                'wilson',
                'share',
                'mean_conviction',
            ]) {
                expect(
                    parseConsensus({ weightModel, confidenceModel }),
                ).toEqual({
                    ...valid,
                    weightModel,
                    confidenceModel,
                });
            }
        }
    });
});

function parseConsensus(overrides: Record<string, unknown>): ConsensusConfig {
    // Parsed through the same schema the process uses, from the raw strings
    // the environment would supply, so a value that only type-checks but
    // cannot be parsed from an env var is caught here.
    return ConsensusConfigParser.parse({
        minimumAgreeing: '2',
        minimumMeanConviction: '0.25',
        weightModel: 'continuous',
        confidenceModel: 'wilson',
        ...overrides,
    });
}

describe('the panel is reported as well as the verdict', () => {
    it('names the indicators that agreed, so a verdict can be argued with', () => {
        const result = calculateConsensus([
            vote(0, 'LONG', 0.9),
            vote(1, 'LONG', 0.8),
        ]);

        // "LONG 71%" is not reviewable. "A и B подтверждают LONG" is.
        expect(result.reason).toBe('A и B подтверждают LONG');
    });

    it('says when the only non-voters abstained rather than disagreed', () => {
        const result = calculateConsensus([
            vote(0, 'LONG', 0.9),
            vote(1, 'LONG', 0.8),
            vote(2, 'NEUTRAL', 0),
        ]);

        expect(result.reason).toMatch(/^Только /);
    });
});
