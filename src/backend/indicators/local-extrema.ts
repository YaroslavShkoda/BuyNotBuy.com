function validateValues(values: number[]): void {
    if (values.length === 0) {
        throw new Error(
            'Local extrema requires at least one value',
        );
    }
}

/**
 * Returns the full run of equal values containing `index`. A flat stretch is
 * one extremum, not zero: with a strict comparison a plateau satisfies nothing
 * and the pivot disappears silently, which is exactly what happened to real
 * price series that print the same close two or three hours in a row.
 */
function findPlateau(
    values: number[],
    index: number,
): { start: number; end: number } {
    const current = values[index];

    let start = index;
    let end = index;

    while (start > 0 && values[start - 1] === current) {
        start -= 1;
    }

    while (end < values.length - 1 && values[end + 1] === current) {
        end += 1;
    }

    return { start, end };
}

/**
 * True when every index in [from, to] exists and sits strictly on the required
 * side of `current`. Out-of-range indices fail on purpose: a pivot needs its
 * full window on both sides before it can be confirmed.
 */
function windowIsStrictlyOutside(
    values: number[],
    current: number,
    from: number,
    to: number,
    wantHigher: boolean,
): boolean {
    for (let index = from; index <= to; index += 1) {
        const neighbour = values[index];

        if (neighbour === undefined) {
            return false;
        }

        if (wantHigher ? neighbour <= current : neighbour >= current) {
            return false;
        }
    }

    return true;
}

/**
 * Collects extrema as the middle of each flat run, so a caller can report the
 * point the market actually turned at instead of an arbitrary edge of it.
 */
function findExtrema(
    values: number[],
    left: number,
    right: number,
    wantHigher: boolean,
): number[] {
    const found: number[] = [];

    let index = 0;

    while (index < values.length) {
        const current = values[index];

        if (current === undefined) {
            index += 1;
            continue;
        }

        const { start, end } = findPlateau(values, index);

        const isExtremum =
            windowIsStrictlyOutside(
                values,
                current,
                start - left,
                start - 1,
                wantHigher,
            ) &&
            windowIsStrictlyOutside(
                values,
                current,
                end + 1,
                end + right,
                wantHigher,
            );

        if (isExtremum) {
            found.push(start + Math.floor((end - start) / 2));
        }

        index = end + 1;
    }

    return found;
}

export function findLocalBottoms(
    values: number[],
    left = 1,
    right = 1,
): number[] {
    validateValues(values);

    if (left <= 0 || right <= 0) {
        throw new Error(
            'Local extrema window must be greater than 0',
        );
    }

    return findExtrema(values, left, right, true);
}

export function findLocalTops(
    values: number[],
    left = 1,
    right = 1,
): number[] {
    validateValues(values);

    if (left <= 0 || right <= 0) {
        throw new Error(
            'Local extrema window must be greater than 0',
        );
    }

    return findExtrema(values, left, right, false);
}
