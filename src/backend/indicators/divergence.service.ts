import type { Candle } from '../types/market.js';

import { indicatorConfig } from '../config/indicator.config.js';

import {
    findLocalBottoms,
    findLocalTops,
} from './local-extrema.js';

import {
    calculateMomentumSeries,
} from './momentum-series.js';

import {
    detectDivergence,
    type DivergencePoint,
    type DivergenceResult,
} from './divergence.js';

import {
    findDivergencePairs,
} from './divergence-pairing.js';

export interface DivergenceAnalysis {
    bullish: DivergenceResult | null;
    bearish: DivergenceResult | null;
}

export interface DivergenceOptions {
    momentumPeriod?: number;
    leftWindow?: number;
    rightWindow?: number;
    maxDistance?: number;
    /** How many bars a confirmed pivot may stay relevant. */
    maxAge?: number;
    momentumSeries?: Array<number | null>;
}

/** Which side of the candle carries the price a pivot is measured on. */
type PriceSide = 'low' | 'high';

function buildDivergencePoint(
    priceIndex: number,
    momentumIndex: number,
    candles: Candle[],
    momentum: Array<number | null>,
    side: PriceSide,
    rightWindow: number,
    lastIndex: number,
): DivergencePoint | null {
    const candle = candles[priceIndex];
    const momentumValue = momentum[momentumIndex];

    if (
        candle === undefined ||
        momentumValue === null ||
        momentumValue === undefined
    ) {
        return null;
    }

    // Both legs have to be confirmed before the formation counts, and the
    // later of the two is the one that settles it.
    const confirmedAtIndex =
        Math.max(priceIndex, momentumIndex) + rightWindow;

    return {
        index: priceIndex,
        confirmedAtIndex,
        age: Math.max(0, lastIndex - confirmedAtIndex),
        // A divergence is a statement about swing extremes, so it is measured
        // on the wick that actually made the turn, not on the close.
        price: side === 'low' ? candle.low : candle.high,
        momentum: momentumValue,
    };
}

/**
 * Keeps only pivots that were confirmed recently enough to still describe the
 * market. Anything older is dropped before pairing, so a stale formation
 * cannot be reported as a live one.
 */
function keepFresh(
    indices: number[],
    rightWindow: number,
    lastIndex: number,
    maxAge: number,
): number[] {
    return indices.filter(
        (index) => lastIndex - (index + rightWindow) <= maxAge,
    );
}

function findFirstDivergence(
    pairs: ReturnType<typeof findDivergencePairs>,
    candles: Candle[],
    momentum: Array<number | null>,
    side: PriceSide,
    expectedType: 'BULLISH' | 'BEARISH',
    rightWindow: number,
    lastIndex: number,
): DivergenceResult | null {
    for (const pair of pairs) {
        const previousPoint = buildDivergencePoint(
            pair.previousPriceIndex,
            pair.previousMomentumIndex,
            candles,
            momentum,
            side,
            rightWindow,
            lastIndex,
        );

        const currentPoint = buildDivergencePoint(
            pair.currentPriceIndex,
            pair.currentMomentumIndex,
            candles,
            momentum,
            side,
            rightWindow,
            lastIndex,
        );

        if (
            previousPoint === null ||
            currentPoint === null
        ) {
            continue;
        }

        const result = detectDivergence(previousPoint, currentPoint);

        if (result.type === expectedType) {
            return result;
        }
    }

    return null;
}

export function analyzeDivergence(
    candles: Candle[],
    options: DivergenceOptions = {},
): DivergenceAnalysis {
    if (candles.length === 0) {
        throw new Error(
            'Divergence analysis requires at least one candle',
        );
    }

    const {
        momentumPeriod = indicatorConfig.momentumPeriod,
        leftWindow = indicatorConfig.divergence.leftWindow,
        rightWindow = indicatorConfig.divergence.rightWindow,
        maxDistance = indicatorConfig.divergence.maxDistance,
        maxAge = indicatorConfig.divergence.maxAge,
        momentumSeries,
    } = options;

    if (maxDistance < 0) {
        throw new Error(
            'Divergence max distance must be greater than or equal to 0',
        );
    }

    if (maxAge < 0) {
        throw new Error(
            'Divergence max age must be greater than or equal to 0',
        );
    }

    const momentum = momentumSeries ?? calculateMomentumSeries(
        candles,
        momentumPeriod,
    );

    const highs = candles.map((candle) => candle.high);
    const lows = candles.map((candle) => candle.low);
    const lastIndex = candles.length - 1;

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

    const fresh = (
        indices: number[],
    ): number[] =>
        keepFresh(
            indices,
            rightWindow,
            lastIndex,
            maxAge,
        );

    // Price pivots come from the wick, momentum pivots from the rate of
    // change series; both are filtered by the same freshness rule.
    const momentumBottoms = fresh(
        findLocalBottoms(
            momentumValues,
            leftWindow,
            rightWindow,
        ).map(
            (position) =>
                validMomentumIndices[position],
        ).filter(
            (index): index is number =>
                index !== undefined,
        ),
    );

    const momentumTops = fresh(
        findLocalTops(
            momentumValues,
            leftWindow,
            rightWindow,
        ).map(
            (position) =>
                validMomentumIndices[position],
        ).filter(
            (index): index is number =>
                index !== undefined,
        ),
    );

    const priceBottoms = fresh(
        findLocalBottoms(
            lows,
            leftWindow,
            rightWindow,
        ),
    );

    const priceTops = fresh(
        findLocalTops(
            highs,
            leftWindow,
            rightWindow,
        ),
    );

    return {
        bullish: findFirstDivergence(
            findDivergencePairs(
                priceBottoms,
                momentumBottoms,
                maxDistance,
            ),
            candles,
            momentum,
            'low',
            'BULLISH',
            rightWindow,
            lastIndex,
        ),
        bearish: findFirstDivergence(
            findDivergencePairs(
                priceTops,
                momentumTops,
                maxDistance,
            ),
            candles,
            momentum,
            'high',
            'BEARISH',
            rightWindow,
            lastIndex,
        ),
    };
}
