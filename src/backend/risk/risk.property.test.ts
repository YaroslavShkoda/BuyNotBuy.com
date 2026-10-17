import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical-input.js';
import { linearPerpInput } from './fixtures.js';
import { buildRiskReport } from './report.js';

/**
 * Properties, not examples: rules that must hold across the whole input space
 * the schema accepts, with fast-check choosing the inputs an example suite
 * would never think of.
 */

describe('canonical serialization', () => {
    it('does not depend on key order, for any object fast-check builds', () => {
        const entries = fc.array(
            fc.tuple(
                fc.string({ minLength: 1, maxLength: 6 }),
                fc.integer({ min: -1_000_000, max: 1_000_000 }),
            ),
            { minLength: 2, maxLength: 12 },
        );

        fc.assert(
            fc.property(entries, (pairs) => {
                // Duplicate keys collapse differently depending on insertion
                // order, and that is JSON's semantics, not the canonical
                // form's business — so the property is stated over distinct
                // keys only.
                const unique = [...new Map(pairs).entries()];
                const forward = Object.fromEntries(unique);
                const backward = Object.fromEntries([...unique].reverse());

                expect(canonicalize(forward)).toBe(canonicalize(backward));
            }),
        );
    });
});

describe('linear-perpetual reports', () => {
    const qty = fc.double({ min: 0.01, max: 10, noNaN: true });
    const entry = fc.double({ min: 1000, max: 50_000, noNaN: true });
    const currentRatio = fc.double({ min: 0.6, max: 1.5, noNaN: true });
    const collateralRatio = fc.double({ min: 0.02, max: 0.9, noNaN: true });
    const mmr = fc.double({ min: 0.001, max: 0.1, noNaN: true });
    const atrValue = fc.double({ min: 0.001, max: 0.1, noNaN: true });
    const funding = fc.option(fc.double({ min: -0.001, max: 0.001, noNaN: true }), {
        nil: null,
    });

    it('agrees with the liquidation formula the report documents', () => {
        fc.assert(
            fc.property(qty, entry, currentRatio, collateralRatio, mmr, atrValue, funding,
                (qtyBase, entryPrice, ratio, collateralPart, maintenance, atr, fundingRate) => {
                    const currentPrice = entryPrice * ratio;
                    const collateralQuote = entryPrice * qtyBase * collateralPart;
                    const input = linearPerpInput({
                        qtyBase,
                        notionalQuote: entryPrice * qtyBase,
                        entryPrice,
                        currentPrice,
                        collateralQuote,
                        atr: { ...linearPerpInput().atr, value: atr },
                        costs: {
                            ...linearPerpInput().costs,
                            fundingRatePerInterval: fundingRate,
                        },
                        margin: {
                            mode: 'isolated',
                            rules: {
                                ...linearPerpInput().margin.rules!,
                                maintenanceMarginRate: maintenance,
                            },
                        },
                    });

                    const report = buildRiskReport(input);

                    const expectedPrice =
                        (entryPrice * qtyBase - collateralQuote) /
                        (qtyBase * (1 - maintenance));
                    const expectedPercent =
                        ((currentPrice - expectedPrice) / currentPrice) * 100;

                    const actualPercent = report.distances.percentDistance.value;

                    expect(actualPercent).not.toBeNull();
                    expect(
                        Math.abs((actualPercent ?? 0) - expectedPercent),
                    ).toBeLessThan(Math.max(1e-6, Math.abs(expectedPercent) * 1e-9));

                    if (atr > 0) {
                        const expectedAtr =
                            Math.abs(currentPrice - expectedPrice) / (atr * currentPrice);
                        const actualAtr = report.distances.atrDistance.value;

                        expect(actualAtr).not.toBeNull();
                        expect(
                            Math.abs((actualAtr ?? 0) - expectedAtr),
                        ).toBeLessThan(Math.max(1e-9, expectedAtr * 1e-9));
                    }
                }),
        );
    });

    it('never lets unknown funding produce a holding cost, and never claims more than degraded', () => {
        fc.assert(
            fc.property(qty, entry, currentRatio, collateralRatio, mmr,
                (qtyBase, entryPrice, ratio, collateralPart, maintenance) => {
                    const currentPrice = entryPrice * ratio;
                    const input = linearPerpInput({
                        qtyBase,
                        notionalQuote: entryPrice * qtyBase,
                        entryPrice,
                        currentPrice,
                        collateralQuote: entryPrice * qtyBase * collateralPart,
                        margin: {
                            mode: 'isolated',
                            rules: {
                                ...linearPerpInput().margin.rules!,
                                maintenanceMarginRate: maintenance,
                            },
                        },
                        costs: {
                            ...linearPerpInput().costs,
                            fundingRatePerInterval: null,
                        },
                    });

                    const report = buildRiskReport(input);
                    const holding = report.positionRisk.metrics.find(
                        (candidate) => candidate.metricKey === 'holdingCostPerIntervalQuote',
                    );

                    expect(holding?.status).toBe('degraded');
                    expect(holding?.value).toBeNull();
                    expect(['valid', 'degraded']).toContain(report.reportStatus);
                }),
        );
    });
});
