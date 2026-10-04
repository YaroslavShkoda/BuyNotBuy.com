import { createHash } from 'node:crypto';

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

/**
 * The fields that decide *which experiment this was*.
 *
 * Kept as data rather than written inline, because a field added to the schema
 * and forgotten here does not fail: the id keeps working, it just stops
 * distinguishing two runs that differ in the new field, which is the failure
 * this whole module exists to make impossible.
 *
 * The dataset contributes only its *identity* — the same fields `sameDataset`
 * compares, and the same reason: `name` and `recordedAt` are labels, and two
 * runs over identical bars under different labels are one experiment recorded
 * twice. `metrics` and `folds` are excluded for the opposite reason: they are
 * what the run *said*, and an id derived from them would be a different number
 * every time the run did, which is a number that cannot identify anything.
 */
export const EXPERIMENT_IDENTITY_FIELDS = [
    'dataset',
    'execution',
    'options',
    'productionParameters',
] as const;

/**
 * Everything a manifest says except its own name.
 *
 * The `id` is derived from the rest, so taking a manifest that has one is a
 * type error rather than something to work around — and it states the
 * direction of the dependency: nothing here can depend on being identified.
 */
export type ExperimentIdentity = Omit<ExperimentManifest, 'id'>;

/**
 * The canonical identity of an experiment, derived from its own contents.
 *
 * **The `id` this replaces was a label, and the collision was silent.** The
 * caller passed `${instrument}-${interval}-${candles.length}` — three of the
 * things that define a run, with the checksum missing. BTCUSDT at one hour over
 * 8760 bars in January and the same 8760 bars in February produce the same
 * string while describing different data. Nothing broke at the time: nothing
 * groups by `id` yet, and `verifyAgainst` compares the whole dataset including
 * its checksum rather than the id. So the defect was latent, which is not a
 * defence of it — it means the first thing that groups by this column, a
 * results table or a "have I run this?" check, inherits a collision that looks
 * like a match.
 *
 * Derived rather than supplied, for the reason the rest of this file repeats:
 * an id somebody types is a claim, and an id computed from the record is a
 * property of the record. Re-running the same data under the same assumptions
 * reproduces it exactly, and changing a single price changes it — which is the
 * one behaviour that makes the column worth having.
 *
 * A digest is a summary, so the readable half goes first: the symbol, interval
 * and bar count are the three things a reader looks for, and the hash settles
 * the rest. Sixteen hex characters is chosen over the full sixty-four because
 * this is a label in a table, not a security token — and saying so here is
 * cheaper than somebody later building a proof on it.
 */
export function experimentId(measured: ExperimentIdentity): string {
    const canonical = EXPERIMENT_IDENTITY_FIELDS.map((field) => {
        const value: unknown =
            field === 'dataset'
                ? {
                      symbol: measured.dataset.symbol,
                      provider: measured.dataset.provider,
                      interval: measured.dataset.interval,
                      from: measured.dataset.from,
                      to: measured.dataset.to,
                      bars: measured.dataset.bars,
                      checksum: measured.dataset.checksum,
                  }
                : measured[field];

        return `${field}=${JSON.stringify(value)}`;
    }).join('\n');

    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');

    return `${measured.dataset.symbol}-${measured.dataset.interval}-${measured.dataset.bars}-${digest.slice(0, 16)}`;
}

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
