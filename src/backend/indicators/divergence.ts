/**
 * Which way a divergence points, and the answer when there is none.
 *
 * A tuple, so the wire can validate it. `api/schemas.ts` retyped these three
 * because `z.enum` wants values and a union is erased at compile time — the same
 * reason every other vocabulary in this project grew a value before a validator
 * could be built from it. `DivergenceService` used to spell out the narrower
 * `'BULLISH' | 'BEARISH'` for the polarity it expected; that is now `Exclude` of
 * this list, which says what it is — two of the three, never `NONE` — instead of
 * saying it by typing the strings out a third time.
 */
export const DIVERGENCE_TYPES = ['BULLISH', 'BEARISH', 'NONE'] as const;

export type DivergenceType = (typeof DIVERGENCE_TYPES)[number];

/** A polarity to look for. `NONE` is an answer, never an expectation. */
export type DivergencePolarity = Exclude<DivergenceType, 'NONE'>;

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
