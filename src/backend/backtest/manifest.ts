import { describeDataset } from './dataset.js';
import { ExperimentManifestSchema } from './experiment.js';

import type { DatasetInput } from './dataset.js';
import type { ExperimentManifest } from './experiment.js';
import type { WalkForwardOptions, WalkForwardResult } from './walk-forward.js';
import type { Candle } from '../types/market.js';

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
    readonly id: string;
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

export function buildManifest(input: ManifestInput): ExperimentManifest {
    return ExperimentManifestSchema.parse({
        id: input.id,
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
}

/** A manifest for a run, without the caller having to name its own fields. */
export function manifestFor(
    result: WalkForwardResult,
    candles: readonly Candle[],
    options: WalkForwardOptions,
    identity: { id: string; name: string; recordedAt: number; commit: string | null },
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
