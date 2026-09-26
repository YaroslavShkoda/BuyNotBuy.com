export interface DivergencePair {
    previousPriceIndex: number;
    previousMomentumIndex: number;
    currentPriceIndex: number;
    currentMomentumIndex: number;
}

export function findDivergencePairs(
    priceExtrema: number[],
    momentumExtrema: number[],
    maxDistance: number,
): DivergencePair[] {
    if (maxDistance < 0) {
        throw new Error(
            'Divergence max distance must be greater than or equal to 0',
        );
    }

    if (priceExtrema.length < 2) {
        return [];
    }

    if (momentumExtrema.length < 2) {
        return [];
    }

    const pairs: DivergencePair[] = [];

    // Both lists are sorted ascending, so a single forward-only pointer pairs
    // them in O(price + momentum). The previous implementation nested four
    // loops over every combination and then sorted the result by distance,
    // which cost hundreds of thousands of iterations per request to pick the
    // tightest - usually the oldest - pair.
    let momentumCursor = 0;

    for (
        let priceCursor = 0;
        priceCursor < priceExtrema.length - 1;
        priceCursor += 1
    ) {
        const previousPriceIndex = priceExtrema[priceCursor];
        const currentPriceIndex = priceExtrema[priceCursor + 1];

        if (
            previousPriceIndex === undefined ||
            currentPriceIndex === undefined
        ) {
            continue;
        }

        while (momentumCursor < momentumExtrema.length - 1) {
            const previousMomentumIndex =
                momentumExtrema[momentumCursor];

            const currentMomentumIndex =
                momentumExtrema[momentumCursor + 1];

            if (
                previousMomentumIndex === undefined ||
                currentMomentumIndex === undefined
            ) {
                break;
            }

            const currentDistance =
                Math.abs(currentMomentumIndex - currentPriceIndex);

            // Momentum has run past this price pivot and will not come back,
            // so the next price pivot is the only candidate left for it.
            if (
                currentDistance > maxDistance &&
                currentMomentumIndex > currentPriceIndex
            ) {
                break;
            }

            const previousDistance =
                Math.abs(previousMomentumIndex - previousPriceIndex);

            if (
                previousDistance <= maxDistance &&
                currentDistance <= maxDistance
            ) {
                pairs.push({
                    previousPriceIndex,
                    previousMomentumIndex,
                    currentPriceIndex,
                    currentMomentumIndex,
                });
            }

            momentumCursor += 1;
        }
    }

    // Most recent first. The signal layer takes the first pair that actually
    // diverges, so a fresh formation can no longer lose to an ancient one
    // that happened to sit closer.
    return pairs.reverse();
}

export function findDivergencePair(
    priceExtrema: number[],
    momentumExtrema: number[],
    maxDistance: number,
): DivergencePair | null {
    return (
        findDivergencePairs(
            priceExtrema,
            momentumExtrema,
            maxDistance,
        )[0] ?? null
    );
}
