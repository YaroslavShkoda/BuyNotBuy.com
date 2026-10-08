import { z } from 'zod';

import { calculateATR } from '../indicators/atr.js';
import { calculateMACD } from '../indicators/macd.js';
import { calculateMomentum } from '../indicators/momentum.js';
import { assessRegime } from '../indicators/regime.js';
import { calculateRSI } from '../indicators/rsi.js';
import { calculateStochastic } from '../indicators/stochastic.js';

import type { Candle } from '../types/market.js';

/**
 * Features, in a form no ML framework has an opinion about.
 *
 * The extractor knows about candles and produces named numbers. It does not
 * know what a tensor, a dataframe or a dataset is, and it must never be given
 * the chance to learn: a feature layer that imports a training library is a
 * feature layer whose output depends on whether the library is installed, and
 * the whole value of a feature vector is that the same candles always produce
 * the same vector. So the contract is a plain object with named, ordered,
 * finite numbers, and the version of the definition is part of it.
 *
 * That version is the other half. A feature vector is only comparable to
 * another one if they were computed the same way, and the ways change — a
 * period moves, a regime gets a fourth level, a divergence measure is replaced.
 * A vector that does not carry the definition that produced it is a number
 * with no provenance, and the moment the definition changes, every model
 * trained on the old one is silently being fed the new one.
 *
 * Nothing here is a decision about which features are good. It is a place to
 * put them so that a later decision can be measured rather than argued about.
 */

export const FEATURE_NAMES = [
    'emaDistance',
    'stochastic',
    'momentum',
    'atr',
    'rsi',
    'macd',
    'macdHistogram',
    'divergence',
    'volatility',
    'volume',
    'returns',
    'regime',
    'signalConfidence',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/**
 * The market regimes, as an encoding.
 *
 * These are the five labels `assessRegime` already produces, reused rather than
 * a second vocabulary invented alongside it. Two spellings of "trending" in one
 * codebase is two things a reader has to reconcile, and one of them is wrong
 * in a way nothing detects.
 *
 * The integer is an **encoding, not a ranking**. `RANGE` is not "between"
 * `TREND_UP` and `HIGH_VOL` in any sense a tree should rely on: a split on
 * this column separates the set {0, 1} from the set {2, 3, 4}, and where that
 * boundary falls is the model's decision, not this file's. So nothing
 * downstream may compare two of these numbers with `<` or `>`, and the names
 * are stored alongside so a vector can be decoded years after the fact
 * without asking this module what it meant.
 */
export const REGIME_LEVELS = [
    'TREND_UP',
    'TREND_DOWN',
    'RANGE',
    'HIGH_VOL',
    'LOW_VOL',
] as const;

type RegimeLevel = (typeof REGIME_LEVELS)[number];

export function regimeLevel(value: number): RegimeLevel {
    return REGIME_LEVELS[value] ?? 'RANGE';
}

export interface FeatureVector {
    readonly version: string;
    /** The bar's own timestamp, in market time. */
    readonly timestamp: number;
    readonly values: Readonly<Record<FeatureName, number>>;
}

export const FeatureVectorSchema = z.object({
    version: z.string().min(1),
    timestamp: z.coerce.number().int(),
    values: z.record(z.enum(FEATURE_NAMES), z.number().finite()),
});

export interface FeatureConfig {
    emaPeriod: number;
    stochasticPeriod: number;
    momentumPeriod: number;
    atrPeriod: number;
    rsiPeriod: number;
    macdFastPeriod: number;
    macdSlowPeriod: number;
    macdSignalPeriod: number;
    /** Bars used for realised volatility and for relative volume. */
    lookback: number;
}

/**
 * The definition's version.
 *
 * Derived from the periods rather than dated, because a date does not change
 * when the code does and these are exactly the settings that decide what a
 * vector means. Two builds with different periods produce different versions,
 * and two builds with the same periods produce the same one whether or not
 * anybody remembered to bump anything.
 */
export function featureVersion(config: FeatureConfig): string {
    return [
        'f1',
        `ema${config.emaPeriod}`,
        `stoch${config.stochasticPeriod}`,
        `mom${config.momentumPeriod}`,
        `atr${config.atrPeriod}`,
        `rsi${config.rsiPeriod}`,
        `macd${config.macdFastPeriod}-${config.macdSlowPeriod}-${config.macdSignalPeriod}`,
        `lb${config.lookback}`,
    ].join('_');
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
    emaPeriod: 300,
    stochasticPeriod: 14,
    momentumPeriod: 10,
    atrPeriod: 14,
    rsiPeriod: 14,
    macdFastPeriod: 12,
    macdSlowPeriod: 26,
    macdSignalPeriod: 9,
    lookback: 20,
};

/**
 * How many bars a vector at the last index needs.
 *
 * The binding constraint is the MACD chain, not any single indicator: the
 * signal line is an EMA of the MACD line, so the MACD line has to exist for
 * `signalPeriod` bars before there is anything to smooth, and that is
 * `slow + signal` bars on top of the slow EMA's own window. Asking for
 * `max(periods)` here produces vectors that are wrong at the start of a
 * series while looking entirely normal, which is the worst kind of wrong.
 */
export function requiredBarsForFeatures(config: FeatureConfig): number {
    return Math.max(
        config.emaPeriod,
        config.stochasticPeriod,
        config.momentumPeriod + 1,
        config.atrPeriod + 1,
        config.rsiPeriod + 1,
        config.macdSlowPeriod + config.macdSignalPeriod,
        config.lookback + 1,
    );
}

function standardDeviation(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
        values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        values.length;

    return Math.sqrt(variance);
}

function emaAt(closes: number[], period: number): number {
    // Seeded with the first `period` values rather than the first value, so
    // the series does not spend its first hundred bars converging on a seed
    // that a single candle happened to produce.
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

    for (let index = period; index < closes.length; index += 1) {
        ema = closes[index]! * k + ema * (1 - k);
    }

    return ema;
}

/**
 * One feature vector, from the candles up to and including `index`.
 *
 * Point-in-time is a property of this signature rather than a promise in a
 * comment: only `candles[0..index]` is reachable, so a feature that peeked at
 * a later bar would have to index past the slice. The dataset layer passes a
 * prefix and a whole history separately, and the test that proves no leakage
 * appends bars to the history and checks the vectors do not move.
 *
 * Throws rather than filling in a default when the prefix is too short. A NaN
 * or a zero in a feature column is a row a model will learn from, and it is
 * far better for the window to be refused than for a plausible-looking number
 * to be invented.
 */
export function extractFeatures(
    candles: readonly Candle[],
    index: number,
    config: FeatureConfig = DEFAULT_FEATURE_CONFIG,
    confidence = 0,
): FeatureVector {
    const prefix = candles.slice(0, index + 1);
    const needed = requiredBarsForFeatures(config);

    if (prefix.length < needed) {
        throw new Error(
            `Признакам нужно ${needed} баров, в срезе ${prefix.length}. Слишком короткое окно лучше отказать, чем заполнить правдоподобным числом.`,
        );
    }

    const closes = prefix.map((candle) => candle.close);
    const last = prefix[prefix.length - 1];

    if (last === undefined) {
        throw new Error('Пустой срез не даёт ни одного признака');
    }

    const ema = emaAt(closes, config.emaPeriod);
    const macd = calculateMACD(
        closes,
        config.macdFastPeriod,
        config.macdSlowPeriod,
        config.macdSignalPeriod,
    );
    const returns: number[] = [];

    for (let bar = 1; bar < closes.length; bar += 1) {
        const previous = closes[bar - 1]!;
        returns.push(previous === 0 ? 0 : (closes[bar]! - previous) / previous);
    }

    const recentReturns = returns.slice(-config.lookback);
    const recentVolumes = prefix
        .slice(-config.lookback)
        .map((candle) => candle.volume);
    const meanVolume =
        recentVolumes.reduce((sum, value) => sum + value, 0) /
        recentVolumes.length;

    const regime = assessRegime({ candles: prefix });

    const values: Record<FeatureName, number> = {
        // Signed and relative, so a feature means the same thing on BTC at
        // 60k and on a token at 0.4.
        emaDistance: ema === 0 ? 0 : (last.close - ema) / ema,
        stochastic: safe(() => calculateStochastic(prefix, config.stochasticPeriod)),
        momentum: safe(() => calculateMomentum(prefix, config.momentumPeriod)),
        // ATR as a fraction of price, for the same reason as the distance.
        atr: safe(() => calculateATR(prefix, config.atrPeriod)) / last.close,
        rsi: safe(() => calculateRSI(prefix, config.rsiPeriod)),
        macd: macd.macd / last.close,
        macdHistogram: macd.histogram / last.close,
        // Signed strength, not a boolean: a weak divergence and a strong one
        // are different facts and a 0/1 column cannot tell them apart.
        divergence: divergenceStrength(prefix),
        volatility: standardDeviation(recentReturns),
        volume: meanVolume === 0 ? 0 : last.volume / meanVolume,
        returns: recentReturns[recentReturns.length - 1] ?? 0,
        regime: REGIME_LEVELS.indexOf(regime.trend),
        signalConfidence: confidence,
    };

    return {
        version: featureVersion(config),
        timestamp: last.timestamp,
        values,
    };
}

/**
 * A degenerate window, reported as zero.
 *
 * Stochastic throws when the highest high equals the lowest low, which is a
 * real and frequent state in a flat market rather than a data error. Filling
 * it with zero says "no information", which is what it is — and refusing the
 * whole window would delete the flat stretches, which are exactly the stretches
 * where a system that only trades trends is being tested.
 */
function safe(compute: () => number): number {
    try {
        const value = compute();

        return Number.isFinite(value) ? value : 0;
    } catch {
        return 0;
    }
}

function divergenceStrength(candles: readonly Candle[]): number {
    const closes = candles.map((candle) => candle.close);
    const lookback = Math.min(closes.length - 1, 20);

    if (lookback < 2) {
        return 0;
    }

    const last = closes[closes.length - 1]!;
    const previous = closes[closes.length - 2]!;
    const beforePrevious = closes[closes.length - 3] ?? previous;

    const momentumNow = last - previous;
    const momentumBefore = previous - beforePrevious;

    // Price made a new extreme while momentum did not follow it. The magnitude
    // is the gap between the two, signed by which side the price is on.
    const priceStep = last - beforePrevious;
    const momentumStep = momentumNow - momentumBefore;

    if (priceStep === 0 || momentumStep === 0) {
        return 0;
    }

    return -momentumStep / Math.abs(priceStep);
}

/**
 * Every vector a series can produce, oldest first.
 *
 * A list rather than a lazy sequence, so a caller cannot accidentally iterate
 * a generator whose `extractFeatures` is still reading a candle array somebody
 * else is appending to.
 */
export function extractFeatureSeries(
    candles: readonly Candle[],
    config: FeatureConfig = DEFAULT_FEATURE_CONFIG,
    confidences: readonly number[] = [],
): FeatureVector[] {
    const vectors: FeatureVector[] = [];
    const start = requiredBarsForFeatures(config);

    for (let index = start - 1; index < candles.length; index += 1) {
        vectors.push(
            extractFeatures(
                candles,
                index,
                config,
                confidences[index] ?? 0,
            ),
        );
    }

    return vectors;
}
