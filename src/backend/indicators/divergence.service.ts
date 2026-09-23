import type { Candle } from '../types/market';

import {
    findLocalBottoms,
    findLocalTops,
} from './local-extrema';

import {
    calculateMomentumSeries,
} from './momentum-series';

import {
    detectDivergence,
    type DivergencePoint,
    type DivergenceResult,
} from './divergence';

import {
    findDivergencePairs,
} from './divergence-pairing';

export interface DivergenceAnalysis {
    bullish: DivergenceResult | null;
    bearish: DivergenceResult | null;
}

function buildDivergencePoint(
    index: number,
    candles: Candle[],
    momentum: Array<number | null>,
): DivergencePoint | null {
    const price = candles[index]?.close;
    const momentumValue = momentum[index];

    if (
        price === undefined ||
        momentumValue === null ||
        momentumValue === undefined
    ) {
        return null;
    }

    return {
        index,
        price,
        momentum: momentumValue,
    };
}

export function analyzeDivergence(
    candles: Candle[],
    momentumPeriod = 100,
    leftWindow = 2,
    rightWindow = 2,
    maxDistance = 5,
    momentumSeries?: Array<number | null>,
): DivergenceAnalysis {
    if (candles.length === 0) {
        throw new Error(
            'Divergence analysis requires at least one candle',
        );
    }

    if (maxDistance < 0) {
        throw new Error(
            'Divergence max distance must be greater than or equal to 0',
        );
    }

    const momentum = momentumSeries ?? calculateMomentumSeries(
        candles,
        momentumPeriod,
    );

    const priceValues = candles.map(
        (candle) => candle.close,
    );

    const validMomentumIndices = momentum
        .map((value, index) =>
            value === null ? null : index,
        )
        .filter(
            (index): index is number =>
                index !== null,
        );

    const momentumValues = validMomentumIndices.map(
        (index) => momentum[index] ?? null,
    ).filter(
        (value): value is number =>
            value !== null,
    );

    const momentumBottomPositions = findLocalBottoms(
        momentumValues,
        leftWindow,
        rightWindow,
    );

    const momentumTopPositions = findLocalTops(
        momentumValues,
        leftWindow,
        rightWindow,
    );

    const momentumBottoms = momentumBottomPositions.map(
        (position) =>
            validMomentumIndices[position],
    ).filter(
        (index): index is number =>
            index !== undefined,
    );

    const momentumTops = momentumTopPositions.map(
        (position) =>
            validMomentumIndices[position],
    ).filter(
        (index): index is number =>
            index !== undefined,
    );

    const priceBottoms = findLocalBottoms(
        priceValues,
        leftWindow,
        rightWindow,
    );

    const priceTops = findLocalTops(
        priceValues,
        leftWindow,
        rightWindow,
    );

    let bullish: DivergenceResult | null = null;
    let bearish: DivergenceResult | null = null;

    const bullishPairs = findDivergencePairs(
        priceBottoms,
        momentumBottoms,
        maxDistance,
    );

    for (const bullishPair of bullishPairs) {
        const previousPoint = buildDivergencePoint(
            bullishPair.previousMomentumIndex,
            candles,
            momentum,
        );

        const currentPoint = buildDivergencePoint(
            bullishPair.currentMomentumIndex,
            candles,
            momentum,
        );

        if (
            previousPoint === null ||
            currentPoint === null
        ) {
            continue;
        }

        const previousPrice =
            candles[bullishPair.previousPriceIndex]?.close;

        const currentPrice =
            candles[bullishPair.currentPriceIndex]?.close;

        if (
            previousPrice === undefined ||
            currentPrice === undefined
        ) {
            continue;
        }

        const result = detectDivergence(
            {
                ...previousPoint,
                price: previousPrice,
            },
            {
                ...currentPoint,
                price: currentPrice,
            },
        );

        if (result.type === 'BULLISH') {
            bullish = result;
            break;
        }
    }

    const bearishPairs = findDivergencePairs(
        priceTops,
        momentumTops,
        maxDistance,
    );

    for (const bearishPair of bearishPairs) {
        const previousPoint = buildDivergencePoint(
            bearishPair.previousMomentumIndex,
            candles,
            momentum,
        );

        const currentPoint = buildDivergencePoint(
            bearishPair.currentMomentumIndex,
            candles,
            momentum,
        );

        if (
            previousPoint === null ||
            currentPoint === null
        ) {
            continue;
        }

        const previousPrice =
            candles[bearishPair.previousPriceIndex]?.close;

        const currentPrice =
            candles[bearishPair.currentPriceIndex]?.close;

        if (
            previousPrice === undefined ||
            currentPrice === undefined
        ) {
            continue;
        }

        const result = detectDivergence(
            {
                ...previousPoint,
                price: previousPrice,
            },
            {
                ...currentPoint,
                price: currentPrice,
            },
        );

        if (result.type === 'BEARISH') {
            bearish = result;
            break;
        }
    }

    return {
        bullish,
        bearish,
    };
}
