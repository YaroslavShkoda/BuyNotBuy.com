import type { PositionSide } from '../types/risk.js';
import { exactMultiply, exactNumber, exactSubtract } from './exact-rational.js';

/** Internal linear/spot quote PnL over validated binary64 inputs. Never serialize. */
export function linearPnlExact(args: {
    readonly side: PositionSide;
    readonly qtyBase: number;
    readonly entryPrice: number;
    readonly exitPrice: number;
}) {
    const gap = exactSubtract(exactNumber(args.exitPrice), exactNumber(args.entryPrice));
    return exactMultiply(gap, exactNumber(args.side === 'LONG' ? args.qtyBase : -args.qtyBase));
}
