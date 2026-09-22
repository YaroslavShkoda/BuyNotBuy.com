function validateValues(values: number[]): void {
    if (values.length === 0) {
        throw new Error(
            'Local extrema requires at least one value',
        );
    }
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

    const bottoms: number[] = [];

    for (
        let index = left;
        index < values.length - right;
        index += 1
    ) {
        const current = values[index];

        let isBottom = true;

        for (
            let offset = 1;
            offset <= left;
            offset += 1
        ) {
            if (current >= values[index - offset]) {
                isBottom = false;
                break;
            }
        }

        if (!isBottom) {
            continue;
        }

        for (
            let offset = 1;
            offset <= right;
            offset += 1
        ) {
            if (current >= values[index + offset]) {
                isBottom = false;
                break;
            }
        }

        if (isBottom) {
            bottoms.push(index);
        }
    }

    return bottoms;
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

    const tops: number[] = [];

    for (
        let index = left;
        index < values.length - right;
        index += 1
    ) {
        const current = values[index];

        let isTop = true;

        for (
            let offset = 1;
            offset <= left;
            offset += 1
        ) {
            if (current <= values[index - offset]) {
                isTop = false;
                break;
            }
        }

        if (!isTop) {
            continue;
        }

        for (
            let offset = 1;
            offset <= right;
            offset += 1
        ) {
            if (current <= values[index + offset]) {
                isTop = false;
                break;
            }
        }

        if (isTop) {
            tops.push(index);
        }
    }

    return tops;
}
