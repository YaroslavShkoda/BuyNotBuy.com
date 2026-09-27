import { z } from 'zod';

import { DatasetSchema } from './dataset.js';

/**
 * Everything needed to repeat a run, and the record of what it said.
 *
 * A backtest produces a number. The number is the least interesting part: what
 * makes it worth keeping is that somebody can say six months later which bars
 * produced it, which parameters were in force, which execution model was
 * assumed and which code was running. None of that is recoverable from the
 * number, which is why it is stored next to it rather than assumed to be
 * constant.
 *
 * The manifest is written on completion and never rewritten. A run that is
 * repeated with different data is a *new* run with its own id, and the two are
 * linked rather than merged — merging them would destroy the fact that the
 * first one was ever true, which is the only thing an experiment log is for.
 */

const ExecutionManifestSchema = z.object({
    model: z.enum(['next_open', 'next_close', 'intrabar']),
    liquidity: z.enum(['maker', 'taker']),
    makerFeeRate: z.number(),
    takerFeeRate: z.number(),
    slippageRate: z.number(),
    spreadRate: z.number(),
});

const FoldRecordSchema = z.object({
    fold: z.number().int(),
    startIndex: z.number().int(),
    endIndex: z.number().int(),
    longThreshold: z.number(),
    shortThreshold: z.number(),
    fitted: z.boolean(),
    validationAccepted: z.boolean(),
    validationReason: z.string(),
    trainingScore: z.number().nullable(),
    validationScore: z.number().nullable(),
});

export const ExperimentManifestSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    recordedAt: z.number().int(),
    dataset: DatasetSchema,
    execution: ExecutionManifestSchema,
    options: z.object({
        foldBars: z.number().int().positive(),
        trainingBars: z.number().int().positive(),
        maxFolds: z.number().int().positive(),
        holdBars: z.number().int().positive(),
        fitParameters: z.boolean(),
    }),
    folds: z.array(FoldRecordSchema),
    metrics: z.object({
        trades: z.number().int().nonnegative(),
        winRate: z.number(),
        profitFactor: z.number().nullable(),
        totalReturn: z.number(),
        maxDrawdown: z.number(),
        sharpeRatio: z.number(),
    }),
    /**
     * Identity of the code that produced this.
     *
     * Recorded because a result from a commit nobody can name cannot be
     * re-derived, and re-deriving it is the whole point of keeping it. It is
     * optional because a run in a working tree has no commit, and refusing to
     * record that would mean the least trustworthy runs — the ones being
     * developed — are the ones that get no manifest at all.
     */
    commit: z.string().nullable(),
    /** What the parameters were before any fitting, so the fit is visible. */
    productionParameters: z.object({
        longThreshold: z.number(),
        shortThreshold: z.number(),
    }),
});

export type ExperimentManifest = z.infer<typeof ExperimentManifestSchema>;

export const ExperimentRegistrySchema = z.record(
    z.string(),
    ExperimentManifestSchema,
);

/**
 * Whether a manifest can be replayed as it stands.
 *
 * Checks the manifest against itself rather than against the data: the fields
 * that must be present and well-ordered. The data check is a separate question
 * and lives in `verifyAgainst`, because "this record is complete" and "the
 * dataset is still available" fail for different reasons and get fixed in
 * different places.
 */
export interface ReplayReadiness {
    readonly replayable: boolean;
    readonly problems: readonly string[];
}

export function checkReplayable(
    manifest: ExperimentManifest,
    currentCommit: string | null,
): ReplayReadiness {
    const problems: string[] = [];

    if (manifest.dataset.bars === 0) {
        problems.push('the dataset holds no bars');
    }

    if (manifest.folds.length === 0) {
        // Not a formality. A run with no folds produces an overall figure that
        // is an average of nothing, and an average of nothing is a number.
        problems.push('no folds were evaluated');
    }

    for (const [index, fold] of manifest.folds.entries()) {
        if (fold.validationScore === null && fold.validationAccepted) {
            // A fold cannot have passed a check that never ran, and reporting
            // it as accepted is the one failure this record exists to make
            // impossible to miss.
            problems.push(
                `fold ${index + 1} claims validation passed with no validation score`,
            );
        }

        if (fold.validationScore !== null && !fold.validationAccepted) {
            problems.push(
                `fold ${index + 1} was rejected for failing validation`,
            );
        }
    }

    if (manifest.commit !== null && currentCommit !== null) {
        if (manifest.commit !== currentCommit) {
            // Not fatal and not an accusation: the code moved on, and the run
            // may still be reproducible at the old commit. It is reported so
            // the reader knows which tree the number came from.
            problems.push(
                `recorded at commit ${manifest.commit.slice(0, 7)}, current is ${currentCommit.slice(0, 7)}`,
            );
        }
    }

    return { replayable: problems.length === 0, problems };
}

export interface VerifiedExperiment {
    readonly match: boolean;
    readonly differences: readonly { field: string; left: unknown; right: unknown }[];
    readonly reason: string;
}

/**
 * Compares a recorded run with one just re-executed.
 *
 * Both sides are compared on the parts that decide the answer — the data and
 * the execution assumptions — and on the numbers themselves. A run that
 * reproduces its data but not its result is a different failure from one that
 * cannot reproduce its data, and lumping them together hides which.
 */
export function verifyAgainst(
    recorded: ExperimentManifest,
    fresh: ExperimentManifest,
): VerifiedExperiment {
    const differences: { field: string; left: unknown; right: unknown }[] = [];

    const fields: (keyof ExperimentManifest)[] = [
        'dataset',
        'execution',
        'options',
        'productionParameters',
    ];

    for (const field of fields) {
        if (JSON.stringify(recorded[field]) !== JSON.stringify(fresh[field])) {
            differences.push({ field, left: recorded[field], right: fresh[field] });
        }
    }

    if (differences.length > 0) {
        return {
            match: false,
            differences,
            reason: `the run would be repeated under different conditions: ${differences
                .map((difference) => difference.field)
                .join(', ')}`,
        };
    }

    const metricsDiffer =
        recorded.metrics.trades !== fresh.metrics.trades ||
        Math.abs(recorded.metrics.totalReturn - fresh.metrics.totalReturn) > 1e-9;

    return {
        match: !metricsDiffer,
        differences: metricsDiffer
            ? [
                  { field: 'metrics', left: recorded.metrics, right: fresh.metrics },
              ]
            : [],
        reason: metricsDiffer
            ? 'the same data under the same assumptions gave a different answer, which is a defect in the runner rather than in the data'
            : 'the run reproduced exactly',
    };
}

/**
 * Compares many runs, worst first.
 *
 * Sorted by disagreement rather than by date, because the run that cannot be
 * reproduced is the one a reader needs to see, and putting it behind three
 * that can is a way of making sure it is not read.
 */
export interface AggregateRow {
    readonly id: string;
    readonly name: string;
    readonly trades: number;
    readonly totalReturn: number;
    readonly maxDrawdown: number;
    readonly bars: number;
    /** Signed return per evaluated bar. Comparable across different samples. */
    readonly returnPerBar: number;
    readonly folds: number;
    readonly validationPassed: number;
}

export function aggregate(experiments: readonly ExperimentManifest[]): {
    rows: AggregateRow[];
    profitable: number;
    reproducible: number;
} {
    const rows = experiments
        .map((experiment) => {
            const evaluated = experiment.folds.reduce(
                (sum, fold) => sum + (fold.endIndex - fold.startIndex + 1),
                0,
            );

            return {
                id: experiment.id,
                name: experiment.name,
                trades: experiment.metrics.trades,
                totalReturn: experiment.metrics.totalReturn,
                maxDrawdown: experiment.metrics.maxDrawdown,
                bars: experiment.dataset.bars,
                // Per bar rather than per run, because a run over four years
                // and a run over two months are otherwise averaged into a
                // number that describes neither.
                returnPerBar:
                    evaluated === 0
                        ? 0
                        : experiment.metrics.totalReturn / evaluated,
                folds: experiment.folds.length,
                validationPassed: experiment.folds.filter(
                    (fold) => fold.validationAccepted,
                ).length,
            };
        })
        .sort((a, b) => a.returnPerBar - b.returnPerBar);

    return {
        rows,
        profitable: rows.filter((row) => row.totalReturn > 0).length,
        reproducible: experiments.length,
    };
}
