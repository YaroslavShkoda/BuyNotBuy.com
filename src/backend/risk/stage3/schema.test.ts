import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type LinearModelInput, LinearModelInputSchema, ManualModelSnapshotSchema, ModelPolicySchema } from './schema.js';
import { validateStage3Input } from './validation.js';

function input(): LinearModelInput {
    return {
        snapshot: {
            schemaVersion: 'margin-model-snapshot/1',
            source: { kind: 'manual', reference: 'manual-record-1' },
            snapshotId: 'snapshot-1', positionId: 'position-1', asOf: 1_700_000_000_000,
            instrument: {
                instrumentId: 'test-linear-contract', contractKind: 'linear_perp',
                baseCurrency: 'BASE', quoteCurrency: 'QUOTE', settlementCurrency: 'QUOTE',
            },
            marginMode: 'isolated', side: 'LONG', qtyBase: 0.5,
            entryPriceQuotePerBase: 40_000, netCashQuote: 4_000,
            cashSemantics: 'settled_net_cash_excluding_unrealized_pnl',
            valuation: {
                priceQuotePerBase: 41_000, basis: 'manual',
                sourceReference: 'price-record-1', asOf: 1_700_000_000_000,
            },
        },
        policy: {
            schemaVersion: 'margin-model-policy/1', modelId: 'generic-linear-isolated',
            modelVersion: '1', source: 'manual', configVersion: 'test-1',
            initialMarginRate: 0.2, maintenanceMarginRate: 0.01,
            initialMarginBasis: 'valuation_notional', maintenanceBasis: 'valuation_notional',
            comparison: 'lt', chargesPolicy: 'settled_cash_only',
            prospectiveCosts: 'excluded', tiersPolicy: 'flat_only',
        },
    };
}

function set(raw: object, path: readonly string[], value: unknown): void {
    let object = raw as Record<string, unknown>;
    for (const key of path.slice(0, -1)) object = object[key] as Record<string, unknown>;
    const key = path.at(-1);
    if (key === undefined) throw new Error('test path must not be empty');
    object[key] = value;
}

function remove(raw: object, path: readonly string[]): void {
    let object = raw as Record<string, unknown>;
    for (const key of path.slice(0, -1)) object = object[key] as Record<string, unknown>;
    const key = path.at(-1);
    if (key === undefined) throw new Error('test path must not be empty');
    delete object[key];
}

function paths(raw: object, prefix: string[] = []): string[][] {
    return Object.entries(raw).flatMap(([key, value]) => {
        const path = [...prefix, key];
        return typeof value === 'object' && value !== null ? [path, ...paths(value, path)] : [path];
    });
}

function freeze(raw: object): void {
    for (const value of Object.values(raw)) if (value !== null && typeof value === 'object') freeze(value);
    Object.freeze(raw);
}

describe('Stage 3 supported snapshots', () => {
    for (const kind of ['manual', 'test'] as const) {
        for (const side of ['LONG', 'SHORT'] as const) {
            it(`accepts a complete ${kind} ${side} snapshot without mutation or defaults`, () => {
                const raw = input();
                raw.snapshot.source.kind = kind;
                raw.snapshot.side = side;
                freeze(raw);
                expect(ManualModelSnapshotSchema.safeParse(raw.snapshot).success).toBe(true);
                expect(ModelPolicySchema.safeParse(raw.policy).success).toBe(true);
                expect(validateStage3Input(raw)).toEqual({ kind: 'supported', input: raw });
                const result = validateStage3Input(raw);
                expect(result).toEqual(validateStage3Input(raw));
                if (result.kind === 'supported') expect(result.input).not.toBe(raw);
            });
        }
    }

    it.each(['lt', 'lte'] as const)('accepts the explicit %s comparator', (comparison) => {
        const raw = input();
        raw.policy.comparison = comparison;
        expect(validateStage3Input(raw).kind).toBe('supported');
    });

    it('accepts zero cash, safe timestamp endpoints and the maximum IM rate', () => {
        for (const asOf of [0, Number.MAX_SAFE_INTEGER]) {
            const raw = input();
            raw.snapshot.netCashQuote = 0;
            raw.snapshot.asOf = raw.snapshot.valuation.asOf = asOf;
            raw.policy.initialMarginRate = 1;
            expect(validateStage3Input(raw).kind).toBe('supported');
        }
    });

    it('accepts representable positive subnormal rates without multiplying a tolerance', () => {
        const raw = input();
        raw.policy.initialMarginRate = 2 * Number.MIN_VALUE;
        raw.policy.maintenanceMarginRate = Number.MIN_VALUE;
        expect(validateStage3Input(raw).kind).toBe('supported');
    });

    it.each(['mark', 'index', 'last', 'bar_close', 'manual'] as const)('preserves valuation basis %s', (basis) => {
        const raw = input();
        raw.snapshot.valuation.basis = basis;
        expect(validateStage3Input(raw)).toEqual({ kind: 'supported', input: raw });
    });

    it('preserves explicit unfamiliar currency labels without guessing their identity', () => {
        const raw = input();
        raw.snapshot.instrument.baseCurrency = 'ZZBASE';
        raw.snapshot.instrument.quoteCurrency = raw.snapshot.instrument.settlementCurrency = 'ZZQUOTE';
        expect(validateStage3Input(raw)).toEqual({ kind: 'supported', input: raw });
    });
});

describe('Stage 3 invalid inputs', () => {
    const numericFields = [
        ['snapshot', 'qtyBase'], ['snapshot', 'entryPriceQuotePerBase'],
        ['snapshot', 'valuation', 'priceQuotePerBase'],
    ];
    for (const path of numericFields) {
        it.each([0, -0, -1, -Number.MIN_VALUE, NaN, Infinity, -Infinity, '1', null])(
            `rejects ${path.join('.')} = %s`, (value) => {
                const raw = input();
                set(raw, path, value);
                expect(validateStage3Input(raw).kind).toBe('invalid');
            },
        );
    }

    it.each([-1, -Number.MIN_VALUE, NaN, Infinity, -Infinity, null, '0'])(
        'rejects invalid net cash %s', (value) => {
            const raw = input();
            set(raw, ['snapshot', 'netCashQuote'], value);
            expect(validateStage3Input(raw).kind).toBe('invalid');
        },
    );

    it.each([
        [0, 0.01], [-1, 0.01], [0.2, 0], [0.2, -0.01], [0.2, 0.2],
        [0.2, 0.3], [1.01, 0.01], [0.2, 1.01], [NaN, 0.01], [0.2, NaN],
        [Infinity, 0.01], [0.2, Infinity], [-Infinity, 0.01], [0.2, -Infinity],
    ])('rejects IM %s / MM %s', (im, mm) => {
        const raw = input();
        raw.policy.initialMarginRate = im;
        raw.policy.maintenanceMarginRate = mm;
        expect(validateStage3Input(raw).kind).toBe('invalid');
    });

    it('names the rate-ordering invariant in a stable machine-readable issue', () => {
        const raw = input();
        raw.policy.maintenanceMarginRate = raw.policy.initialMarginRate;
        expect(validateStage3Input(raw)).toMatchObject({
            kind: 'invalid', issues: [{ path: ['policy', 'maintenanceMarginRate'], rule: 'MAINTENANCE_BELOW_INITIAL' }],
        });
    });

    it.each(['baseCurrency', 'quoteCurrency', 'settlementCurrency'])(
        'rejects malformed currency identifiers in %s', (field) => {
            for (const value of ['', ' ', 'usd', ' USD', 'USD ', 'A', 'A'.repeat(13), 'US-D', null]) {
                const raw = input();
                set(raw, ['snapshot', 'instrument', field], value);
                expect(validateStage3Input(raw).kind).toBe('invalid');
            }
        },
    );

    it('rejects equal base/quote and unequal settlement/quote', () => {
        const base = input();
        base.snapshot.instrument.baseCurrency = base.snapshot.instrument.quoteCurrency;
        const settlement = input();
        settlement.snapshot.instrument.settlementCurrency = 'OTHER';
        expect(validateStage3Input(base)).toMatchObject({
            kind: 'invalid', issues: [{ rule: 'BASE_DIFFERS_FROM_QUOTE' }],
        });
        expect(validateStage3Input(settlement)).toMatchObject({
            kind: 'invalid', issues: [{ rule: 'SETTLEMENT_EQUALS_QUOTE' }],
        });
    });

    for (const path of [['snapshot', 'asOf'], ['snapshot', 'valuation', 'asOf']]) {
        it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0', null])(
            `rejects invalid timestamp ${path.join('.')} = %s`, (value) => {
                const raw = input();
                set(raw, path, value);
                expect(validateStage3Input(raw).kind).toBe('invalid');
            },
        );
    }

    it('rejects individually valid but inconsistent timestamps', () => {
        const raw = input();
        raw.snapshot.valuation.asOf += 1;
        expect(validateStage3Input(raw)).toMatchObject({
            kind: 'invalid', issues: [{ rule: 'SNAPSHOT_TIME_EQUALS_VALUATION_TIME' }],
        });
    });

    const identifiers = [
        ['snapshot', 'snapshotId'], ['snapshot', 'positionId'], ['snapshot', 'instrument', 'instrumentId'],
        ['policy', 'configVersion'], ['policy', 'modelId'], ['policy', 'modelVersion'],
    ];
    for (const path of identifiers) {
        it(`bounds ${path.join('.')} and rejects blanks without trimming`, () => {
            for (const value of ['', ' ', '\t\n', ' padded ', 'x'.repeat(129)]) {
                const raw = input();
                set(raw, path, value);
                expect(validateStage3Input(raw).kind).toBe('invalid');
            }
        });
    }

    for (const path of [['snapshot', 'source', 'reference'], ['snapshot', 'valuation', 'sourceReference']]) {
        it(`bounds nonblank reference ${path.join('.')}`, () => {
            for (const value of ['', ' ', ' padded ', 'x'.repeat(257)]) {
                const raw = input();
                set(raw, path, value);
                expect(validateStage3Input(raw).kind).toBe('invalid');
            }
        });
    }

    for (const path of paths(input())) {
        it(`requires ${path.join('.')} without supplying a default`, () => {
            const raw = input();
            remove(raw, path);
            const before = structuredClone(raw);
            expect(validateStage3Input(raw).kind).toBe('invalid');
            expect(LinearModelInputSchema.safeParse(raw).success).toBe(false);
            expect(raw).toEqual(before);
        });
    }

    for (const path of [[], ['snapshot'], ['snapshot', 'source'], ['snapshot', 'instrument'], ['snapshot', 'valuation'], ['policy']]) {
        it(`rejects unknown fields and tiers at ${path.join('.') || 'root'}`, () => {
            for (const key of ['unknown', 'tiers']) {
                const raw = input();
                set(raw, [...path, key], []);
                expect(validateStage3Input(raw)).toMatchObject({
                    kind: 'invalid', issues: expect.arrayContaining([{ path, code: 'unrecognized_keys', rule: null, unknownKeys: [key] }]),
                });
            }
        });
    }

    it.each([
        [['snapshot', 'cashSemantics'], 'collateral_including_pnl'],
        [['snapshot', 'source', 'kind'], 'internal'],
        [['snapshot', 'valuation', 'basis'], 'unknown'],
        [['policy', 'source'], 'automatic'],
        [['policy', 'comparison'], '<'],
        [['policy', 'initialMarginBasis'], 'entry_notional'],
        [['policy', 'maintenanceBasis'], 'entry_notional'],
        [['policy', 'chargesPolicy'], 'guess_zero'],
        [['policy', 'prospectiveCosts'], 'included'],
        [['policy', 'tiersPolicy'], 'tiered'],
        [['policy', 'schemaVersion'], 'margin-model-policy/2'],
        [['snapshot', 'schemaVersion'], 'margin-model-snapshot/2'],
    ])('rejects a substituted semantic field %s', (path, value) => {
        const raw = input();
        set(raw, path, value);
        expect(validateStage3Input(raw).kind).toBe('invalid');
    });
});

describe('Stage 3 scope classification', () => {
    it.each([
        [['snapshot', 'marginMode'], 'cross', ['UNSUPPORTED_SCOPE']],
        [['snapshot', 'instrument', 'contractKind'], 'inverse_perp', ['UNSUPPORTED_SCOPE']],
        [['snapshot', 'instrument', 'contractKind'], 'spot', ['UNSUPPORTED_SCOPE']],
        [['policy', 'modelId'], 'venue-specific-linear', ['UNSUPPORTED_SCOPE', 'FORMULA_UNKNOWN']],
        [['policy', 'modelId'], 'unconfirmed-model', ['UNSUPPORTED_SCOPE', 'FORMULA_UNKNOWN']],
        [['policy', 'modelVersion'], '2', ['UNSUPPORTED_SCOPE', 'FORMULA_UNVERIFIED']],
    ])('refuses a recognized unsupported selector %s', (path, value, reasons) => {
        const raw = input();
        set(raw, path, value);
        expect(validateStage3Input(raw)).toMatchObject({ kind: 'unsupported', status: 'insufficient_data', reasons });
        expect(LinearModelInputSchema.safeParse(raw).success).toBe(false);
    });

    it('does not accept venue assertions as metadata on a generic model', () => {
        const raw = input();
        set(raw, ['basis'], { kind: 'venue_rules', venueConformance: 'verified' });
        expect(validateStage3Input(raw).kind).toBe('invalid');
    });

    it('recognizes inverse base settlement without applying linear settlement requirements', () => {
        const raw = input();
        set(raw, ['snapshot', 'instrument', 'contractKind'], 'inverse_perp');
        raw.snapshot.instrument.settlementCurrency = raw.snapshot.instrument.baseCurrency;
        expect(validateStage3Input(raw)).toMatchObject({
            kind: 'unsupported', status: 'insufficient_data', reasons: ['UNSUPPORTED_SCOPE'],
        });
        expect(LinearModelInputSchema.safeParse(raw).success).toBe(false);
    });

    it('rejects trailing line breaks in currencies without normalization', () => {
        const raw = input();
        raw.snapshot.instrument.quoteCurrency = raw.snapshot.instrument.settlementCurrency = 'QUOTE\n';
        expect(validateStage3Input(raw).kind).toBe('invalid');
    });

    it('prioritizes malformed requests over unsupported scope', () => {
        const raw = input();
        set(raw, ['snapshot', 'marginMode'], 'cross');
        remove(raw, ['snapshot', 'qtyBase']);
        expect(validateStage3Input(raw).kind).toBe('invalid');
    });

    it('treats unknown selectors as invalid and combined known selectors deterministically', () => {
        const unknown = input();
        set(unknown, ['snapshot', 'marginMode'], 'made-up-mode');
        expect(validateStage3Input(unknown).kind).toBe('invalid');
        const combined = input();
        set(combined, ['snapshot', 'marginMode'], 'cross');
        set(combined, ['policy', 'modelVersion'], '2');
        expect(validateStage3Input(combined)).toMatchObject({
            kind: 'unsupported', reasons: ['UNSUPPORTED_SCOPE', 'FORMULA_UNVERIFIED'],
        });
        expect(validateStage3Input(combined)).toEqual(validateStage3Input(combined));
    });
});

it('orders machine-readable errors independently of unknown-key insertion order', () => {
    const first = { ...input(), z: 1, a: 2 };
    const second = { a: 2, z: 1, ...input() };
    expect(validateStage3Input(first)).toEqual(validateStage3Input(second));
    expect(validateStage3Input(first)).toEqual(JSON.parse(JSON.stringify(validateStage3Input(first))));
});

it('never throws for deterministic arbitrary JSON-like requests', () => {
    fc.assert(fc.property(fc.jsonValue(), (raw) => {
        expect(() => validateStage3Input(raw)).not.toThrow();
        expect(validateStage3Input(raw)).toEqual(validateStage3Input(raw));
    }), { seed: 30201, numRuns: 500 });
});

it('validates schema-valid inputs across binary64 and safe timestamp limits without throwing', () => {
    fc.assert(fc.property(
        fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true }),
        fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true }),
        fc.double({ min: 0, max: Number.MAX_VALUE, noNaN: true }),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (qty, price, cash, asOf) => {
            const raw = input();
            raw.snapshot.qtyBase = qty;
            raw.snapshot.entryPriceQuotePerBase = raw.snapshot.valuation.priceQuotePerBase = price;
            raw.snapshot.netCashQuote = cash;
            raw.snapshot.asOf = raw.snapshot.valuation.asOf = asOf;
            expect(LinearModelInputSchema.safeParse(raw).success).toBe(true);
            expect(() => validateStage3Input(raw)).not.toThrow();
            expect(validateStage3Input(raw)).toEqual({ kind: 'supported', input: raw });
        },
    ), { seed: 30202, numRuns: 500 });
});
