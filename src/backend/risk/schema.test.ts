import { describe, expect, it } from 'vitest';
import { inversePerpInput, linearPerpInput, reviewedInverseRules, spotInput } from './fixtures.js';
import { RiskInputSchema } from './schema.js';

/**
 * The input schema is the front door: whatever the tests reject here can never
 * reach a report. Every refusal names its field, because a refusal that does
 * not say what was wrong sends the operator back into the JSON to guess.
 */

const parse = (input: unknown) => RiskInputSchema.safeParse(input);

describe('a valid input is accepted', () => {
    it('accepts the baseline linear-perpetual input and applies defaults', () => {
        const result = parse(linearPerpInput());

        expect(result.success).toBe(true);

        if (result.success) {
            expect(result.data.margin.mode).toBe('isolated');
            expect(result.data.scenarios).toEqual([]);
        }
    });

    it('accepts an inverse input without contract parameters', () => {
        // Missing inverse parameters are a completeness question for the
        // report (which answers `insufficient_data`), not a syntax question
        // for the schema.
        const input = inversePerpInput({
            positionId: 'test-inverse-001',
            contractKind: 'inverse_perp',
            contractSizeUsd: null,
            marginCurrency: null,
            margin: {
                mode: 'isolated',
                rules: {
                    ...reviewedInverseRules(),
                    contractKind: 'inverse_perp',
                    liquidationFormulaId: 'inverse_manual_v1',
                },
            },
        });

        expect(parse(input).success).toBe(true);
    });
});

describe('missing and malformed fields are refused, naming the field', () => {
    it('refuses an input without positionId', () => {
        const input = linearPerpInput();
        const { positionId: _omitted, ...rest } = input;

        const result = parse(rest);

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0]?.path).toEqual(['positionId']);
        }
    });

    it('refuses zero and negative sizes and prices', () => {
        for (const [field, value] of [
            ['qtyBase', 0],
            ['qtyBase', -1],
            ['entryPrice', 0],
            ['currentPrice', -5],
            ['collateralQuote', -100],
        ] as const) {
            const result = parse(linearPerpInput({ [field]: value }));

            expect(result.success, `${field} = ${value}`).toBe(false);
            if (!result.success) {
                expect(result.error.issues[0]?.path.includes(field)).toBe(true);
            }
        }
    });

    it('refuses NaN and Infinity wherever a number is required', () => {
        const nanInput = parse(linearPerpInput({ qtyBase: Number.NaN }));
        const infiniteInput = parse(linearPerpInput({ currentPrice: Number.POSITIVE_INFINITY }));

        expect(nanInput.success).toBe(false);
        expect(infiniteInput.success).toBe(false);
    });

    it('refuses non-integer and implausible timestamps', () => {
        expect(parse(linearPerpInput({ observedAt: 1_730_104_400_000.5 })).success).toBe(false);
        expect(parse(linearPerpInput({ now: -1 })).success).toBe(false);
    });

    it('refuses an interval the pipeline does not compute', () => {
        const result = parse({
            ...linearPerpInput(),
            interval: '2h',
        });

        expect(result.success).toBe(false);
    });
});

describe('identifiers are resolved against the registries the project owns', () => {
    it('refuses a ticker the asset registry cannot resolve', () => {
        const result = parse(linearPerpInput({ ticker: 'ZZZZZZZ' }));

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0]?.path).toEqual(['ticker']);
        }
    });

    it('refuses a quote currency that disagrees with the registry', () => {
        const result = parse(linearPerpInput({ quoteCurrency: 'USDC' }));

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0]?.path).toEqual(['quoteCurrency']);
        }
    });

    it('refuses an ATR that belongs to another venue, symbol or interval', () => {
        const wrongInterval = parse(
            linearPerpInput({ atr: { ...linearPerpInput().atr, interval: '4h' } }),
        );
        const wrongVenue = parse(
            linearPerpInput({ atr: { ...linearPerpInput().atr, venue: 'bitget' } }),
        );

        expect(wrongInterval.success).toBe(false);
        expect(wrongVenue.success).toBe(false);
    });
});

describe('cross-field consistency', () => {
    it('refuses a notional that disagrees with quantity times entry price', () => {
        const result = parse(linearPerpInput({ notionalQuote: 12345 }));

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0]?.path).toEqual(['notionalQuote']);
        }
    });

    it('checks an inverse notional against contracts x confirmed size, not the linear formula', () => {
        const inverseBase = {
            contractKind: 'inverse_perp' as const,
            contractSizeUsd: 100,
            marginCurrency: 'base' as const,
            margin: {
                mode: 'isolated' as const,
                rules: {
                    ...reviewedInverseRules(),
                    contractKind: 'inverse_perp' as const,
                    liquidationFormulaId: 'inverse_manual_v1',
                    contractSizeUsd: 100,
                    marginCurrency: 'base' as const,
                },
            },
        };

        // The linear identity 0.5 x 40000 = 20000 is meaningless here: the
        // inverse notional is 0.5 x 100 = 50, so the fixture notional is a
        // contradiction and must be refused.
        const linearFormulaNotional = parse(inversePerpInput(inverseBase));

        expect(linearFormulaNotional.success).toBe(false);
        if (!linearFormulaNotional.success) {
            expect(linearFormulaNotional.error.issues[0]?.path).toEqual([
                'notionalQuote',
            ]);
        }

        const confirmed = parse(inversePerpInput({ ...inverseBase, notionalQuote: 50 }));

        expect(confirmed.success).toBe(true);
    });

    it('skips the inverse notional cross-check while the size is unconfirmed', () => {
        // Without a confirmed contract size the notional cannot be verified;
        // that is a completeness question for the report, not a syntax one.
        const result = parse(
            inversePerpInput({
                contractKind: 'inverse_perp',
                contractSizeUsd: null,
                marginCurrency: null,
                margin: {
                    mode: 'isolated',
                    rules: {
                        ...reviewedInverseRules(),
                        contractKind: 'inverse_perp',
                        liquidationFormulaId: 'inverse_manual_v1',
                    },
                },
            }),
        );

        expect(result.success).toBe(true);
    });

    it('refuses candles with a gap and a mismatched last-closed bar', () => {
        const gapped = linearPerpInput();
        gapped.market.candles[10]!.timestamp += 60_000;

        const result = parse(gapped);

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0]?.path[0]).toBe('market');
        }

        const mismatched = parse(
            linearPerpInput({ market: { ...linearPerpInput().market, lastClosedBarTime: 1 } }),
        );

        expect(mismatched.success).toBe(false);
    });

    it('refuses a margin config naming another venue, kind or mode', () => {
        const borrowed = linearPerpInput({
            margin: {
                mode: 'isolated',
                rules: {
                    ...linearPerpInput().margin.rules!,
                    venue: 'bitget',
                },
            },
        });

        const result = parse(borrowed);

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0]?.path.join('.')).toContain('margin');
        }
    });

    it('refuses maker fee above taker fee', () => {
        const result = parse(
            linearPerpInput({
                costs: {
                    ...linearPerpInput().costs,
                    takerFeeRate: 0.001,
                    makerFeeRate: 0.01,
                },
            }),
        );

        expect(result.success).toBe(false);
    });
});

describe('contract-kind applicability is enforced at the door', () => {
    it('refuses a spot input that carries margin or collateral', () => {
        const withMode = parse(
            spotInput({ margin: { mode: 'isolated', rules: null } }),
        );
        const withCollateral = parse(spotInput({ collateralQuote: 100 }));

        expect(withMode.success).toBe(false);
        expect(withCollateral.success).toBe(false);
    });

    it('refuses a perpetual without collateral or margin mode', () => {
        const noCollateral = parse(linearPerpInput({ collateralQuote: null }));
        const noMode = parse(
            linearPerpInput({ margin: { mode: null, rules: null } }),
        );

        expect(noCollateral.success).toBe(false);
        expect(noMode.success).toBe(false);
    });
});
