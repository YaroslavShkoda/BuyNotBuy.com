import type { Candle } from '../types/market.js';
import type { DatasetInput } from './dataset.js';
import { describeDataset } from './dataset.js';
import type { ExperimentManifest } from './experiment.js';
import { ExperimentManifestSchema, experimentId } from './experiment.js';
import type { WalkForwardOptions, WalkForwardResult } from './walk-forward.js';

/**
 * Turns a finished run into a record that can be repeated.
 *
 * The record is built from the result object rather than from the inputs plus
 * a second call, so what is stored is what was produced. Collecting the inputs
 * and re-deriving the outputs would store a different thing whenever the
 * runner changed, and the manifest would then describe a run that never
 * happened.
 */

export interface ManifestInput {
    readonly name: string;
    readonly recordedAt: number;
    readonly dataset: DatasetInput;
    readonly options: WalkForwardOptions;
    readonly result: WalkForwardResult;
    readonly productionParameters: {
        longThreshold: number;
        shortThreshold: number;
    };
    readonly commit: string | null;
}

/**
 * Built, then named.
 *
 * There is no `id` parameter, and that is the point. The identity is computed
 * from the record that was just assembled, so it cannot disagree with it and
 * cannot be typed in — the caller used to pass
 * `${instrument}-${interval}-${candles.length}`, which was three of the fields
 * that define an experiment with the checksum left out, and which gave two
 * datasets that differed only in their prices the same name. See
 * `experimentId` for the rest.
 */
export function buildManifest(input: ManifestInput): ExperimentManifest {
    // Parsed without the id, because the id is what the parse produces: a
    // schema that demanded a name before anything had been measured would be
    // asking for the answer first.
    const measured = ExperimentManifestSchema.omit({ id: true }).parse({
        name: input.name,
        recordedAt: input.recordedAt,
        dataset: describeDataset(input.dataset),
        execution: {
            model: input.options.execution.model,
            liquidity: input.options.execution.liquidity,
            makerFeeRate: input.options.execution.makerFeeRate,
            takerFeeRate: input.options.execution.takerFeeRate,
            slippageRate: input.options.execution.slippageRate,
            spreadRate: input.options.execution.spreadRate,
        },
        options: {
            foldBars: input.options.foldBars,
            trainingBars: input.options.trainingBars,
            maxFolds: input.options.maxFolds,
            holdBars: input.options.holdBars,
            fitParameters: input.options.fitParameters,
        },
        folds: input.result.folds.map((fold) => ({
            fold: fold.fold,
            startIndex: fold.startIndex,
            endIndex: fold.endIndex,
            longThreshold: fold.parameters.longThreshold,
            shortThreshold: fold.parameters.shortThreshold,
            fitted: fold.fitted,
            validationAccepted: fold.validation.accepted,
            validationReason: fold.validation.reason,
            trainingScore: fold.validation.trainingScore,
            validationScore: fold.validation.validationScore,
        })),
        metrics: {
            trades: input.result.overall.trades,
            winRate: input.result.overall.winRate,
            profitFactor: input.result.overall.profitFactor,
            totalReturn: input.result.overall.totalReturn,
            maxDrawdown: input.result.overall.maxDrawdown,
            sharpeRatio: input.result.overall.sharpeRatio,
        },
        commit: input.commit,
        productionParameters: input.productionParameters,
    });

    return { ...measured, id: experimentId(measured) };
}

/** A manifest for a run, without the caller having to name its own fields. */
export function manifestFor(
    result: WalkForwardResult,
    candles: readonly Candle[],
    options: WalkForwardOptions,
    identity: { name: string; recordedAt: number; commit: string | null },
    series: { name: string; symbol: string; provider: string; interval: string },
    productionParameters: { longThreshold: number; shortThreshold: number },
): ExperimentManifest {
    return buildManifest({
        ...identity,
        // The dataset is stamped with the run's own time, so the two records
        // cannot disagree about when the data was looked at.
        dataset: { ...series, candles, recordedAt: identity.recordedAt },
        options,
        result,
        productionParameters,
    });
}
