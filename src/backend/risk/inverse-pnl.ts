import type { PositionSide } from '../types/risk.js';
import { exactDivide, exactMultiply, exactNumber, exactSubtract } from './exact-rational.js';

/** Internal exact results; never attach these BigInts to a public report. */
export function inversePnlExact(args: {
    readonly qtyBase: number;
    readonly contractSizeUsd: number;
    readonly entryPrice: number;
    readonly exitPrice: number;
    readonly currentPrice: number;
    readonly side: PositionSide;
}) {
    const entry = exactNumber(args.entryPrice);
    const exit = exactNumber(args.exitPrice);
    const notional = exactMultiply(exactNumber(args.qtyBase), exactNumber(args.contractSizeUsd));
    const signedNotional = exactMultiply(exactNumber(args.side === 'LONG' ? 1 : -1), notional);
    const base = exactDivide(
        exactMultiply(signedNotional, exactSubtract(exit, entry)),
        exactMultiply(entry, exit),
    );
    return { base, quote: exactMultiply(base, exactNumber(args.currentPrice)) };
}
