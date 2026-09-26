export type DivergenceType =
    | 'BULLISH'
    | 'BEARISH'
    | 'NONE';

export interface DivergencePoint {
    index: number;
    /**
     * First bar that made this pivot knowable. A swing low is only confirmed
     * after `rightWindow` further bars, so a pivot must never be presented as
     * a current reading before that bar.
     */
    confirmedAtIndex: number;
    /** Bars elapsed since confirmation, at the end of the analysed window. */
    age: number;
    price: number;
    momentum: number;
}

export interface DivergenceResult {
    type: DivergenceType;
    previous: DivergencePoint;
    current: DivergencePoint;
}

export function detectDivergence(
    previous: DivergencePoint,
    current: DivergencePoint,
): DivergenceResult {
    if (
        current.price < previous.price &&
        current.momentum > previous.momentum
    ) {
        return {
            type: 'BULLISH',
            previous,
            current,
        };
    }

    if (
        current.price > previous.price &&
        current.momentum < previous.momentum
    ) {
        return {
            type: 'BEARISH',
            previous,
            current,
        };
    }

    return {
        type: 'NONE',
        previous,
        current,
    };
}
