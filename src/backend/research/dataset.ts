import { z } from 'zod';

import { FEATURE_NAMES, featureVersion, DEFAULT_FEATURE_CONFIG } from './features.js';

import type { FeatureName, FeatureVector, FeatureConfig } from './features.js';
import type { Candle } from '../types/market.js';

/**
 * History turned into rows a model can be trained on, and the three ways that
 * goes wrong.
 *
 * The rows are plain arrays and plain numbers, in a fixed column order, with
 * the feature version beside them. That is the whole interface: XGBoost,
 * LightGBM, sklearn and PyTorch all take something that can be turned into a
 * matrix in one line, and the point of refusing to depend on any of them is
 * that the row can be written to a file today and read by a library that does
 * not exist yet.
 *
 * The failure this module exists to prevent is not a slow pipeline. It is a
 * model that scores beautifully and means nothing, and that needs exactly three
 * things to be true.
 *
 * The features are point-in-time, which is the extractor's job and is tested
 * there. The label is allowed to look forward — a label that did not would be
 * not a label — and that is precisely why the split needs care: a training
 * row's label resolves some bars *after* the row. A split that divides by row
 * count puts training rows whose answers are computed from test-period prices
 * into the training set, and the model learns from the test set's future
 * without a single feature having moved. So the split is by time and then
 * **purged**: a training row whose label horizon reaches into the test window
 * is dropped, not kept.
 *
 * Determinism is the third. The same candles and the same configuration
 * produce the same rows, byte for byte, and the version travels with them so
 * that "byte for byte" is checkable rather than hoped for.
 */

export const DATASET_SCHEMA_VERSION = 'ds1';

export const DatasetRowSchema = z.object({
    /** Fixed order: FEATURE_NAMES. A map here would let a row be reordered. */
    features: z.array(z.number().finite()).length(FEATURE_NAMES.length),
    /** 1 if the forward return was positive, 0 if not, null if unknown. */
    label: z.number().int().min(0).max(1).nullable(),
    timestamp: z.coerce.number().int(),
    symbol: z.string().min(1),
    regime: z.string().min(1),
    /** Realised forward return at the horizon, null until the bars arrive. */
    outcome: z.number().finite().nullable(),
    /** Bars until the label resolves. Decides purging at a split. */
    horizonBars: z.coerce.number().int().positive(),
    featureVersion: z.string().min(1),
    datasetVersion: z.literal(DATASET_SCHEMA_VERSION),
});

export type DatasetRow = z.infer<typeof DatasetRowSchema>;

export interface DatasetConfig extends FeatureConfig {
    symbol: string;
    /** Bars ahead the label looks. */
    horizonBars: number;
    /** Bar spacing, in ms. Used to keep horizons comparable across series. */
    intervalMs: number;
}

export const DEFAULT_DATASET_CONFIG: DatasetConfig = {
    ...DEFAULT_FEATURE_CONFIG,
    symbol: 'BTCUSDT',
    horizonBars: 24,
    intervalMs: 3_600_000,
};

/**
 * The label, from the price after the row rather than from the price on it.
 *
 * Signed on the return, not on the direction of the trend that produced the
 * row. Those disagree often, and a label that agrees with the features is a
 * label that carries no information a model could not have read off them.
 */
export function labelFor(
    candles: readonly Candle[],
    index: number,
    horizonBars: number,
): { label: number | null; outcome: number | null } {
    const from = candles[index];
    const to = candles[index + horizonBars];

    if (from === undefined || to === undefined || from.close === 0) {
        // The horizon has not closed yet. A row whose answer does not exist is
        // kept, with a null label, because dropping it would quietly bias the
        // dataset toward periods where the market happened to keep moving.
        return { label: null, outcome: null };
    }

    const outcome = to.close / from.close - 1;

    return { label: outcome > 0 ? 1 : 0, outcome };
}

export interface BuildOptions {
    /** Confidence per bar, carried into the vector as a feature. */
    confidences?: readonly number[];
    /** Bar-by-bar regime names, for the row's readable column. */
    regimes?: readonly string[];
}

export function buildDataset(
    vectors: readonly FeatureVector[],
    candles: readonly Candle[],
    config: DatasetConfig = DEFAULT_DATASET_CONFIG,
    options: BuildOptions = {},
): DatasetRow[] {
    const byTimestamp = new Map<number, number>();

    candles.forEach((candle, index) => {
        byTimestamp.set(candle.timestamp, index);
    });

    return vectors.map((vector) => {
        const index = byTimestamp.get(vector.timestamp);
        const { label, outcome } =
            index === undefined
                ? { label: null, outcome: null }
                : labelFor(candles, index, config.horizonBars);

        return {
            features: FEATURE_NAMES.map((name) => vector.values[name]),
            label,
            timestamp: vector.timestamp,
            symbol: config.symbol,
            regime: options.regimes?.[index ?? 0] ?? 'UNKNOWN',
            outcome,
            horizonBars: config.horizonBars,
            featureVersion: vector.version,
            datasetVersion: DATASET_SCHEMA_VERSION,
        } satisfies DatasetRow;
    });
}

/**
 * The same dataset twice, exactly.
 *
 * A property rather than a hope. A pipeline that is deterministic on one
 * machine and not another produces a dataset whose reproducibility is a
 * function of the phase of the moon, and the only evidence that it happened is
 * that two numbers differed three weeks later.
 */
export function datasetChecksum(rows: readonly DatasetRow[]): string {
    // FNV-1a over a canonical text form. Not a cryptographic hash and not
    // pretending to be: the question is whether two runs agree, and the answer
    // has to be stable across processes without pulling in a dependency.
    let hash = 0x811c9dc5;

    for (const row of rows) {
        const text = [
            row.datasetVersion,
            row.featureVersion,
            row.symbol,
            row.regime,
            row.timestamp,
            row.horizonBars,
            row.label ?? 'null',
            row.outcome ?? 'null',
            ...row.features.map((value) => value.toPrecision(15)),
        ].join('|');

        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface Split {
    readonly train: readonly DatasetRow[];
    readonly validation: readonly DatasetRow[];
    readonly test: readonly DatasetRow[];
    /**
     * Rows dropped because their label reaches into a later split.
     *
     * Reported rather than silent. A dataset that quietly loses a few thousand
     * rows at a split boundary reads as a dataset of a certain size, and the
     * size is the thing people plan around.
     */
    readonly purged: number;
    readonly boundary: { train: number; validation: number; test: number };
}

/**
 * Divide by time, then purge.
 *
 * The proportions are of *time*, not of rows, because rows are unevenly
 * spaced in general and a count-based split silently becomes a time-based one
 * wherever the data is dense. A caller that wants rows does not get them by
 * asking for a different unit.
 *
 * Purging drops any row whose label horizon would resolve at or after the start
 * of the split that follows it. A row at the end of train, whose answer is
 * computed from prices in the validation window, has seen the validation
 * window. Keeping it is the single most common way a time-series model reports
 * a result that will not reproduce in production, and it is invisible in every
 * metric — the fit gets better, not worse.
 */
export function splitByTime(
    rows: readonly DatasetRow[],
    train = 0.6,
    validation = 0.2,
    intervalMs = DEFAULT_DATASET_CONFIG.intervalMs,
): Split {
    const ordered = [...rows].sort((left, right) => left.timestamp - right.timestamp);

    if (ordered.length === 0) {
        return {
            train: [],
            validation: [],
            test: [],
            purged: 0,
            boundary: { train: 0, validation: 0, test: 0 },
        };
    }

    const total = ordered.length;
    const trainEnd = Math.floor(total * train);
    const validationEnd = Math.floor(total * (train + validation));

    // The timestamp at which each later split begins. A training row whose
    // label resolves at or after this has an answer computed from prices the
    // model is about to be tested against.
    const validationStart = ordered[validationEnd]?.timestamp ?? Number.POSITIVE_INFINITY;
    const testStart =
        ordered[Math.min(validationEnd, total - 1)]?.timestamp ?? Number.POSITIVE_INFINITY;

    const trainCandidates = ordered.slice(0, trainEnd);
    const validationCandidates = ordered.slice(trainEnd, validationEnd);

    // The horizon is in bars, and a bar is however long the series says it is.
    // Carrying the interval rather than assuming an hour is the difference
    // between purging the right number of rows and purging an arbitrary one.
    const horizonMs = (row: DatasetRow) => row.horizonBars * intervalMs;

    const keptTrain = trainCandidates.filter(
        (row) => row.timestamp + horizonMs(row) < validationStart,
    );
    const keptValidation = validationCandidates.filter(
        (row) => row.timestamp + horizonMs(row) < testStart,
    );

    return {
        train: keptTrain,
        validation: keptValidation,
        test: ordered.slice(validationEnd),
        purged:
            trainCandidates.length -
            keptTrain.length +
            (validationCandidates.length - keptValidation.length),
        boundary: {
            train: ordered[trainEnd - 1]?.timestamp ?? 0,
            validation: validationStart,
            test: testStart,
        },
    };
}

export interface Matrix {
    /** Rows by FEATURE_NAMES, in that order. */
    readonly x: number[][];
    readonly y: number[];
    readonly featureNames: readonly FeatureName[];
    readonly featureVersion: string;
    readonly rows: number;
}

/**
 * Rows as a matrix, with a decided fate for unlabelled ones.
 *
 * `dropUnlabelled` defaults to true and that default is the point. A row whose
 * horizon has not closed has no answer, and the two things you can do with it
 * are drop it or invent a label. Inventing one is the single most effective way
 * to build a model that looks trained and is not.
 */
export function toMatrix(
    rows: readonly DatasetRow[],
    options: { dropUnlabelled?: boolean } = {},
): Matrix {
    const drop = options.dropUnlabelled ?? true;
    const kept = rows.filter((row) => (drop ? row.label !== null : true));

    return {
        x: kept.map((row) => row.features),
        y: kept.map((row) => row.label ?? 0),
        featureNames: [...FEATURE_NAMES],
        featureVersion: kept[0]?.featureVersion ?? featureVersion(DEFAULT_FEATURE_CONFIG),
        rows: kept.length,
    };
}

export interface DatasetSummary {
    readonly rows: number;
    readonly labelled: number;
    readonly unlabelled: number;
    readonly from: number;
    readonly to: number;
    readonly checksum: string;
    readonly featureVersion: string;
    readonly datasetVersion: string;
}

export function summarize(rows: readonly DatasetRow[]): DatasetSummary {
    const ordered = [...rows].sort((left, right) => left.timestamp - right.timestamp);
    const labelled = rows.filter((row) => row.label !== null).length;

    return {
        rows: rows.length,
        labelled,
        unlabelled: rows.length - labelled,
        from: ordered[0]?.timestamp ?? 0,
        to: ordered[ordered.length - 1]?.timestamp ?? 0,
        checksum: datasetChecksum(rows),
        featureVersion: rows[0]?.featureVersion ?? 'unknown',
        datasetVersion: DATASET_SCHEMA_VERSION,
    };
}
