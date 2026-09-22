export type DivergenceType =
    | 'BULLISH'
    | 'BEARISH'
    | 'NONE';

export interface DivergencePoint {
    index: number;
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
