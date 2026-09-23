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

    const pairs: Array<{
        pair: DivergencePair;
        distance: number;
    }> = [];

    for (
        let previousPrice = 0;
        previousPrice < priceExtrema.length - 1;
        previousPrice += 1
    ) {
        for (
            let currentPrice = previousPrice + 1;
            currentPrice < priceExtrema.length;
            currentPrice += 1
        ) {
            const previousPriceIndex =
                priceExtrema[previousPrice];

            const currentPriceIndex =
                priceExtrema[currentPrice];

            if (
                previousPriceIndex === undefined ||
                currentPriceIndex === undefined
            ) {
                continue;
            }

            for (
                let previousMomentum = 0;
                previousMomentum < momentumExtrema.length - 1;
                previousMomentum += 1
            ) {
                for (
                    let currentMomentum =
                        previousMomentum + 1;
                    currentMomentum < momentumExtrema.length;
                    currentMomentum += 1
                ) {
                    const previousMomentumIndex =
                        momentumExtrema[previousMomentum];

                    const currentMomentumIndex =
                        momentumExtrema[currentMomentum];

                    if (
                        previousMomentumIndex === undefined ||
                        currentMomentumIndex === undefined
                    ) {
                        continue;
                    }

                    const previousDistance =
                        Math.abs(
                            previousMomentumIndex -
                                previousPriceIndex,
                        );

                    const currentDistance =
                        Math.abs(
                            currentMomentumIndex -
                                currentPriceIndex,
                        );

                    if (
                        previousDistance > maxDistance ||
                        currentDistance > maxDistance
                    ) {
                        continue;
                    }

                    pairs.push({
                        pair: {
                            previousPriceIndex,
                            previousMomentumIndex,
                            currentPriceIndex,
                            currentMomentumIndex,
                        },
                        distance:
                            previousDistance +
                            currentDistance,
                    });
                }
            }
        }
    }

    pairs.sort(
        (a, b) => a.distance - b.distance,
    );

    return pairs.map(
        ({ pair }) => pair,
    );
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
