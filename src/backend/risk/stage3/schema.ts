import { z } from 'zod';

// No registry/environment reads: these are explicit model labels, not claims
// that a currency or derivative has been verified against a venue catalogue.
const currency = z.string().regex(/^[A-Z0-9]{2,12}$/);
const identifier = z.string().min(1).max(128).refine(
    (value) => value.trim() === value && value.trim().length > 0,
    { params: { rule: 'NONBLANK_UNPADDED_IDENTIFIER' } },
);
const reference = z.string().min(1).max(256).refine(
    (value) => value.trim() === value && value.trim().length > 0,
    { params: { rule: 'NONBLANK_UNPADDED_REFERENCE' } },
);
const positive = z.number().finite().positive();
const timestamp = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);

const policyEnvelope = z.strictObject({
    schemaVersion: z.literal('margin-model-policy/1'),
    modelId: identifier,
    modelVersion: identifier,
    source: z.literal('manual'),
    configVersion: identifier,
    initialMarginRate: z.number().finite().positive().max(1),
    maintenanceMarginRate: z.number().finite().positive().max(1),
    initialMarginBasis: z.literal('valuation_notional'),
    maintenanceBasis: z.literal('valuation_notional'),
    comparison: z.enum(['lt', 'lte']),
    chargesPolicy: z.literal('settled_cash_only'),
    prospectiveCosts: z.literal('excluded'),
    tiersPolicy: z.literal('flat_only'),
}).refine((policy) => policy.maintenanceMarginRate < policy.initialMarginRate, {
    path: ['maintenanceMarginRate'],
    params: { rule: 'MAINTENANCE_BELOW_INITIAL' },
});

export const ModelPolicySchema = policyEnvelope.safeExtend({
    modelId: z.literal('generic-linear-isolated'),
    modelVersion: z.literal('1'),
});

const instrumentEnvelope = z.strictObject({
    instrumentId: identifier,
    contractKind: z.enum(['spot', 'linear_perp', 'inverse_perp']),
    baseCurrency: currency,
    quoteCurrency: currency,
    settlementCurrency: currency,
});

const snapshotEnvelope = z.strictObject({
    schemaVersion: z.literal('margin-model-snapshot/1'),
    source: z.strictObject({
        kind: z.enum(['manual', 'test']),
        reference,
    }),
    snapshotId: identifier,
    positionId: identifier,
    asOf: timestamp,
    instrument: instrumentEnvelope,
    marginMode: z.enum(['isolated', 'cross']),
    side: z.enum(['LONG', 'SHORT']),
    qtyBase: positive,
    entryPriceQuotePerBase: positive,
    netCashQuote: z.number().finite().min(0),
    cashSemantics: z.literal('settled_net_cash_excluding_unrealized_pnl'),
    valuation: z.strictObject({
        priceQuotePerBase: positive,
        basis: z.enum(['mark', 'index', 'last', 'bar_close', 'manual']),
        sourceReference: reference,
        asOf: timestamp,
    }),
});

export const ManualModelSnapshotSchema = snapshotEnvelope.extend({
    instrument: instrumentEnvelope.extend({ contractKind: z.literal('linear_perp') }),
    marginMode: z.literal('isolated'),
}).superRefine((snapshot, ctx) => {
    if (snapshot.instrument.baseCurrency === snapshot.instrument.quoteCurrency) {
        ctx.addIssue({
            code: 'custom', path: ['instrument', 'baseCurrency'],
            params: { rule: 'BASE_DIFFERS_FROM_QUOTE' },
        });
    }
    if (snapshot.instrument.quoteCurrency !== snapshot.instrument.settlementCurrency) {
        ctx.addIssue({
            code: 'custom', path: ['instrument', 'settlementCurrency'],
            params: { rule: 'SETTLEMENT_EQUALS_QUOTE' },
        });
    }
    if (snapshot.asOf !== snapshot.valuation.asOf) {
        ctx.addIssue({
            code: 'custom', path: ['valuation', 'asOf'],
            params: { rule: 'SNAPSHOT_TIME_EQUALS_VALUATION_TIME' },
        });
    }
});

export const LinearModelInputSchema = z.strictObject({
    snapshot: ManualModelSnapshotSchema,
    policy: ModelPolicySchema,
});

/**
 * Classification envelope, NOT a cross/inverse/venue input contract. It admits
 * scope selectors only so well-shaped requests can receive an explicit refusal.
 * Field syntax is checked before classification. Linear-only currency/time
 * invariants are applied at the supported boundary, never to inverse/cross.
 */
export const Stage3RequestEnvelopeSchema = z.strictObject({
    snapshot: snapshotEnvelope,
    policy: policyEnvelope,
});

export type ModelPolicy = z.infer<typeof ModelPolicySchema>;
export type ManualModelSnapshot = z.infer<typeof ManualModelSnapshotSchema>;
export type LinearModelInput = z.infer<typeof LinearModelInputSchema>;
