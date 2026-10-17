import fc from 'fast-check';
import { expect, it } from 'vitest';
import { allMetrics, inversePerpInput } from './fixtures.js';
import { potentialPnl } from './position-math.js';
import { buildRiskReport } from './report.js';

// Independent oracle: ordinary reduced fractions, decoded from exact base-2
// strings. Rounding searches adjacent binary64 values and compares distances;
// it does not reproduce the production significand/exponent rounding algorithm.
interface Fraction { n: bigint; d: bigint }
function fraction(n: bigint, d = 1n): Fraction {
    let a = n < 0n ? -n : n;
    let b = d < 0n ? -d : d;
    while (b !== 0n) [a, b] = [b, a % b];
    const sign = d < 0n ? -1n : 1n;
    return { n: sign * n / a, d: sign * d / a };
}
function fromNumber(value: number): Fraction {
    const [integer = '0', decimals = ''] = Math.abs(value).toString(2).split('.');
    return fraction((value < 0 ? -1n : 1n) * BigInt(`0b${integer}${decimals}`), 1n << BigInt(decimals.length));
}
const mul = (a: Fraction, b: Fraction) => fraction(a.n * b.n, a.d * b.d);
const div = (a: Fraction, b: Fraction) => fraction(a.n * b.d, a.d * b.n);
const sub = (a: Fraction, b: Fraction) => fraction(a.n * b.d - b.n * a.d, a.d * b.d);
const compare = (a: Fraction, b: Fraction) => a.n * b.d - b.n * a.d;
const view = new DataView(new ArrayBuffer(8));
function fromBits(bits: bigint): number {
    view.setBigUint64(0, bits);
    return view.getFloat64(0);
}
const maxBits = 0x7fefffffffffffffn;
const overflowMidpoint = sub(fromNumber(Number.MAX_VALUE), fromNumber(-(2 ** 970)));
const failure = { value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW' };
function rounded(value: Fraction) {
    if (value.n === 0n) return { value: 0, status: 'valid', reasonCode: null };
    const positive = fraction(value.n < 0n ? -value.n : value.n, value.d);
    if (compare(positive, overflowMidpoint) >= 0n) return failure;
    let low = 0n;
    let high = maxBits;
    while (low < high) {
        const middle = (low + high + 1n) / 2n;
        if (compare(fromNumber(fromBits(middle)), positive) <= 0n) low = middle;
        else high = middle - 1n;
    }
    if (low < maxBits) {
        const down = sub(positive, fromNumber(fromBits(low)));
        const up = sub(fromNumber(fromBits(low + 1n)), positive);
        const distance = compare(down, up);
        if (distance > 0n || (distance === 0n && (low & 1n) === 1n)) low += 1n;
    }
    if (low === 0n) return failure;
    return { value: (value.n < 0n ? -1 : 1) * fromBits(low), status: 'valid', reasonCode: null };
}

const positive = fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true });
it('matches independent fractions and adjacent-value rounding over the binary64 exponent range', () => {
    fc.assert(fc.property(
        positive, positive, positive, positive, positive, positive,
        fc.constantFrom('LONG', 'SHORT'), fc.constantFrom('base', 'quote'),
        fc.constantFrom('random', 'flat', 'adjacent'),
        (qtyBase, contractSizeUsd, entryPrice, exitCandidate, currentPrice, collateralQuote, side, marginCurrency, movement) => {
            const notional = qtyBase * contractSizeUsd;
            fc.pre(Number.isFinite(notional) && notional > 0);
            let exitPrice = exitCandidate;
            if (movement === 'flat') exitPrice = entryPrice;
            if (movement === 'adjacent') {
                view.setFloat64(0, entryPrice);
                const bits = view.getBigUint64(0);
                fc.pre(bits < maxBits);
                exitPrice = fromBits(bits + 1n);
            }
            const exactNotional = mul(fromNumber(qtyBase), fromNumber(contractSizeUsd));
            const sign = fromNumber(side === 'LONG' ? 1 : -1);
            const base = mul(mul(sign, exactNotional), sub(div(fromNumber(1), fromNumber(entryPrice)), div(fromNumber(1), fromNumber(exitPrice))));
            const quote = mul(base, fromNumber(currentPrice));
            const percent = mul(div(quote, fromNumber(notional)), fromNumber(100));
            const actual = potentialPnl({ contractKind: 'inverse_perp', side, qtyBase, contractSizeUsd, entryPrice, currentPrice, exitPrice, marginCurrency });
            expect(actual.quote).toEqual(rounded(quote));
            expect(actual.percent).toEqual(rounded(percent));
            expect(actual.base).toEqual(marginCurrency === 'base' ? rounded(base) : {
                value: null, status: 'not_applicable', reasonCode: 'INVERSE_SETTLEMENT_NOT_BASE',
            });

            const unrealizedBase = mul(mul(sign, exactNotional), sub(div(fromNumber(1), fromNumber(entryPrice)), div(fromNumber(1), fromNumber(currentPrice))));
            const unrealizedQuote = mul(unrealizedBase, fromNumber(currentPrice));
            const rom = mul(div(unrealizedQuote, fromNumber(collateralQuote)), fromNumber(100));
            const fixture = inversePerpInput();
            const raw = buildRiskReport(inversePerpInput({
                side, qtyBase, contractSizeUsd, entryPrice, currentPrice, exitPriceQuote: exitPrice,
                marginCurrency, collateralQuote, notionalQuote: notional,
                margin: { mode: 'isolated', rules: null }, costs: { ...fixture.costs, fundingRatePerInterval: 0 },
            }));
            const serialized = JSON.parse(JSON.stringify(raw, (_key, value: unknown) => {
                expect(typeof value).not.toBe('bigint');
                if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
                return value;
            })) as typeof raw;
            for (const report of [raw, serialized]) {
                const metrics = new Map(allMetrics(report).map((block) => [block.metricKey, block]));
                expect(metrics.get('returnOnMarginPercent')).toMatchObject(rounded(rom));
                expect(metrics.get('unrealizedPnlQuote')).toMatchObject(rounded(unrealizedQuote));
                expect(metrics.get('potentialPnlQuote')).toMatchObject(actual.quote);
                expect(metrics.get('potentialPnlPercentOfEntryNotional')).toMatchObject(actual.percent);
                expect(metrics.get('potentialPnlBaseUnits')).toMatchObject(actual.base!);
                if (allMetrics(report).some((block) => block.status === 'calculation_error')) {
                    expect(report.positionRisk.status).toBe('calculation_error');
                    expect(report.reportStatus).toBe('calculation_error');
                }
                expect(report.marginViolation.detected).toBeNull();
                expect(report.liquidationConsequences.status).toBe('insufficient_data');
            }
        },
    ), { seed: 2232026, numRuns: 1000, examples: [
        [1, 1e-300, 1e100, 2e100, 1e100, 1, 'LONG', 'base', 'random'],
        [1, Number.MIN_VALUE, 1, 2, 1.5, Number.MIN_VALUE, 'SHORT', 'base', 'random'],
    ] });
}, 60_000);
