import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allMetrics, inversePerpInput, linearPerpInput, reviewedInverseRules } from './fixtures.js';
import {
    absoluteNotionalQuote,
    directedExposureQuote,
    estimatedRoundTripCost,
    invalidationDistance,
    potentialPnl,
} from './position-math.js';
import { buildRiskReport } from './report.js';

/**
 * Properties, not examples: invariants that must hold across the whole input
 * space the schema accepts, with fast-check choosing the inputs an example
 * suite would never think of.
 */

const qty = fc.double({ min: 0.0001, max: 1000, noNaN: true });
const entry = fc.double({ min: 0.01, max: 100_000, noNaN: true });
const price = fc.double({ min: 0.01, max: 100_000, noNaN: true });
const size = fc.double({ min: 0.01, max: 10_000, noNaN: true });
const rate = fc.double({ min: 0, max: 0.1, noNaN: true });

describe('direction', () => {
    it('flips the sign of directed exposure without moving its magnitude', () => {
        fc.assert(
            fc.property(qty, entry, size, (qtyBase, entryPrice, contractSizeUsd) => {
                const longSpec = {
                    contractKind: 'inverse_perp',
                    side: 'LONG',
                    qtyBase,
                    entryPrice,
                    contractSizeUsd,
                    marginCurrency: 'base',
                } as const;
                const shortSpec = { ...longSpec, side: 'SHORT' } as const;

                const longExposure = directedExposureQuote(longSpec).value ?? 0;
                const shortExposure = directedExposureQuote(shortSpec).value ?? 0;

                expect(longExposure).toBeCloseTo(-shortExposure, 9);
                expect(Math.abs(longExposure)).toBeCloseTo(
                    Math.abs(absoluteNotionalQuote(longSpec).value ?? 0),
                    9,
                );
            }),
        );
    });

    it('flips the sign of the potential PnL for every contract kind', () => {
        fc.assert(
            fc.property(
                qty,
                entry,
                price,
                size,
                fc.constantFrom('spot', 'linear_perp', 'inverse_perp'),
                (qtyBase, entryPrice, exitPrice, contractSizeUsd, contractKind) => {
                    const isInverse = contractKind === 'inverse_perp';
                    const args = {
                        contractKind,
                        side: 'LONG',
                        qtyBase,
                        entryPrice,
                        currentPrice: exitPrice,
                        exitPrice,
                        contractSizeUsd: isInverse ? contractSizeUsd : null,
                        marginCurrency: isInverse ? 'base' : null,
                    } as const;

                    const longPnl = potentialPnl(args).quote.value ?? 0;
                    const shortResult = potentialPnl({
                        ...args,
                        side: 'SHORT',
                    });

                    expect(longPnl).toBeCloseTo(-(shortResult.quote.value ?? 0), 9);

                    const longPercent = potentialPnl(args).percent.value ?? 0;
                    const shortPercent = shortResult.percent.value ?? 0;

                    expect(longPercent).toBeCloseTo(-shortPercent, 9);
                },
            ),
        );
    });
});

describe('magnitudes', () => {
    it('never produce a negative or non-finite absolute notional', () => {
        fc.assert(
            fc.property(
                qty,
                entry,
                size,
                fc.constantFrom('spot', 'linear_perp', 'inverse_perp'),
                (qtyBase, entryPrice, contractSizeUsd, contractKind) => {
                    const isInverse = contractKind === 'inverse_perp';
                    const result = absoluteNotionalQuote({
                        contractKind,
                        side: 'LONG',
                        qtyBase,
                        entryPrice,
                        contractSizeUsd: isInverse ? contractSizeUsd : null,
                        marginCurrency: isInverse ? 'base' : null,
                    });

                    expect(result.status).toBe('valid');

                    const value = result.value ?? 0;

                    expect(value).toBeGreaterThan(0);
                    expect(Number.isFinite(value)).toBe(true);
                },
            ),
        );
    });
});

describe('invalidation distance', () => {
    it('grows as the level moves further to the adverse side', () => {
        fc.assert(
            fc.property(
                entry,
                fc.double({ min: 0.0001, max: 0.9, noNaN: true }),
                fc.double({ min: 0.0001, max: 0.9, noNaN: true }),
                (entryPrice, nearFraction, farFraction) => {
                    const near = entryPrice * (1 - nearFraction);
                    const far = entryPrice * (1 - farFraction * 2);

                    fc.pre(far > 0);
                    fc.pre(far < near);

                    const nearDistance = invalidationDistance({
                        side: 'LONG',
                        entryPrice,
                        levelQuote: near,
                    });
                    const farDistance = invalidationDistance({
                        side: 'LONG',
                        entryPrice,
                        levelQuote: far,
                    });

                    expect(
                        (farDistance.percent.value ?? 0) >
                            (nearDistance.percent.value ?? 0),
                    ).toBe(true);
                },
            ),
        );
    });

    it('is exactly zero at the entry and contradicted beyond it', () => {
        fc.assert(
            fc.property(entry, (entryPrice) => {
                const atEntry = invalidationDistance({
                    side: 'LONG',
                    entryPrice,
                    levelQuote: entryPrice,
                });

                expect(atEntry.absolute.value).toBe(0);

                const beyond = invalidationDistance({
                    side: 'LONG',
                    entryPrice,
                    levelQuote: entryPrice * 1.0001,
                });

                expect(beyond.absolute.reasonCode).toBe(
                    'INVALIDATION_LEVEL_CONTRADICTS_SIDE',
                );
            }),
        );
    });
});

describe('execution cost', () => {
    it('grows monotonically in every rate component', () => {
        fc.assert(
            fc.property(
                qty,
                entry,
                rate,
                rate,
                rate,
                rate,
                fc.double({ min: 1e-9, max: 0.01, noNaN: true }),
                (
                    qtyBase,
                    entryPrice,
                    takerFeeRate,
                    spreadRate,
                    slippageRate,
                    executionReserveRate,
                    bump,
                ) => {
                    const rates = {
                        takerFeeRate,
                        spreadRate,
                        slippageRate,
                        executionReserveRate,
                    };
                    const base = estimatedRoundTripCost(
                        qtyBase * entryPrice,
                        rates,
                    ).quote.value;
                    const bumped = estimatedRoundTripCost(qtyBase * entryPrice, {
                        ...rates,
                        slippageRate: slippageRate + bump,
                    }).quote.value;

                    expect((bumped ?? 0) > (base ?? 0)).toBe(true);
                },
            ),
        );
    });
});

describe('the whole report', () => {
    it('never carries a NaN or Infinity metric for any accepted input', () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0.01, max: 10, noNaN: true }),
                fc.double({ min: 1000, max: 50_000, noNaN: true }),
                fc.double({ min: 0.6, max: 1.5, noNaN: true }),
                fc.option(fc.double({ min: 0.001, max: 0.1, noNaN: true }), {
                    nil: null,
                }),
                (qtyBase, entryPrice, ratio, exitRatio) => {
                    const input = linearPerpInput({
                        qtyBase,
                        notionalQuote: entryPrice * qtyBase,
                        entryPrice,
                        currentPrice: entryPrice * ratio,
                        exitPriceQuote:
                            exitRatio === null ? null : entryPrice * exitRatio,
                        invalidationLevelQuote:
                            ratio < 1 ? entryPrice * ratio * 0.5 : null,
                    });

                    const report = buildRiskReport(input);

                    for (const metricBlock of allMetrics(report)) {
                        if (metricBlock.value !== null) {
                            expect(Number.isFinite(metricBlock.value)).toBe(
                                true,
                            );
                        }

                        if (metricBlock.status === 'valid') {
                            expect(metricBlock.value).not.toBeNull();
                        } else {
                            expect(metricBlock.reasonCode).not.toBeNull();
                        }
                    }
                },
            ),
        );
    });

    it('agrees with the unrealized PnL when the exit is the current price', () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0.01, max: 10, noNaN: true }),
                fc.double({ min: 1000, max: 50_000, noNaN: true }),
                fc.double({ min: 0.6, max: 1.5, noNaN: true }),
                (qtyBase, entryPrice, ratio) => {
                    const currentPrice = entryPrice * ratio;
                    const input = linearPerpInput({
                        qtyBase,
                        notionalQuote: entryPrice * qtyBase,
                        entryPrice,
                        currentPrice,
                        exitPriceQuote: currentPrice,
                    });

                    const report = buildRiskReport(input);
                    const byKey = new Map(
                        report.positionRisk.metrics.map((metricBlock) => [
                            metricBlock.metricKey,
                            metricBlock,
                        ]),
                    );

                    const unrealized = byKey.get('unrealizedPnlQuote')?.value;
                    const potential = byKey.get('potentialPnlQuote')?.value;

                    expect(potential).not.toBeNull();
                    expect(potential).toBeCloseTo(unrealized ?? 0, 9);
                },
            ),
        );
    });

    it('keeps the inverse answer sufficient only with a confirmed spec', () => {
        fc.assert(
            fc.property(qty, entry, price, (qtyBase, entryPrice, exitPrice) => {
                const input = inversePerpInput({
                    contractKind: 'inverse_perp',
                    qtyBase,
                    notionalQuote: entryPrice * qtyBase,
                    entryPrice,
                    currentPrice: entryPrice,
                    exitPriceQuote: exitPrice,
                    margin: {
                        mode: 'isolated',
                        rules: reviewedInverseRules({
                            contractKind: 'inverse_perp',
                            liquidationFormulaId: 'inverse_manual_v1',
                        }),
                    },
                });

                const report = buildRiskReport(input);
                const byKey = new Map(
                    report.positionRisk.metrics.map((metricBlock) => [
                        metricBlock.metricKey,
                        metricBlock,
                    ]),
                );

                expect(byKey.get('entryNotionalQuote')?.status).toBe(
                    'insufficient_data',
                );
                expect(byKey.get('potentialPnlQuote')?.reasonCode).toBe(
                    'MISSING_INVERSE_CONTRACT_PARAMS',
                );
            }),
        );
    });
});
