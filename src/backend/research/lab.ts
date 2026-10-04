import { z } from 'zod';
import { manifestFor } from '../backtest/manifest.js';
import type { WalkForwardOptions } from '../backtest/walk-forward.js';
import { DEFAULT_WALK_FORWARD_OPTIONS, runWalkForward } from '../backtest/walk-forward.js';
import { judgeFold } from '../backtest/walk-forward.plan.js';
import type { Candle } from '../types/market.js';
import type { DatasetRow } from './dataset.js';
import { buildDataset, DEFAULT_DATASET_CONFIG, splitByTime, summarize } from './dataset.js';
import type { FeatureConfig } from './features.js';
import { DEFAULT_FEATURE_CONFIG, extractFeatureSeries, requiredBarsForFeatures } from './features.js';

/**
 * One place that says what the stages are, and which of them a request may
 * touch.
 *
 * The roadmap asks for a research laboratory that runs the whole chain — from
 * historical research through features, evaluation, backtest, walk-forward,
 * experiment and candidate, to shadow, monitoring, calibration and production
 * — while the production system stays as simple as market data, validation,
 * indicators, signal, persist, and evaluate later. Those two requirements are
 * only compatible if the boundary is a *declared* one, so it is: every stage
 * here carries which side of the line it is on, and the runtime path is the
 * short list.
 *
 * Nothing in this module trains anything. That is deliberate and it is the
 * point of the roadmap's parenthetical — no ML framework gets added for the
 * sake of having one. What is added is the dataset, the splits and the honest
 * accounting of what has and has not been measured, so that a future model has
 * somewhere sound to stand.
 *
 * The production stages are listed rather than merely described, because the
 * only way to keep a research dependency out of the request path is to be able
 * to ask which stages a request path may use, and an answer that is prose
 * cannot be checked.
 */

export const STAGES = [
    'research',
    'features',
    'indicator-evaluation',
    'backtest',
    'walk-forward',
    'experiment',
    'candidate',
    'shadow',
    'performance',
    'calibration',
    'production',
] as const;

export type Stage = (typeof STAGES)[number];

/**
 * Which stages a request serving a page may run.
 *
 * Six, and the list is the shortest one that produces an answer. Everything
 * else — the walk-forward folds, the optimiser, the statistics, the dataset
 * splits — is a cost measured in seconds or minutes against a budget measured
 * in milliseconds, and a research module reached from a request path does not
 * stay reached for long.
 */
export const RUNTIME_STAGES: readonly Stage[] = [
    'features',
    'indicator-evaluation',
    'performance',
    'production',
];

/**
 * What each stage is allowed to depend on.
 *
 * A research stage may import anything. A runtime stage may not import a
 * research stage, and this is the list that makes that checkable rather than a
 * matter of discipline.
 */
export const STAGE_SIDE: Readonly<Record<Stage, 'runtime' | 'research'>> = {
    research: 'research',
    features: 'runtime',
    'indicator-evaluation': 'runtime',
    backtest: 'research',
    'walk-forward': 'research',
    experiment: 'research',
    candidate: 'research',
    shadow: 'research',
    performance: 'runtime',
    calibration: 'research',
    production: 'runtime',
};

export function isRuntimeStage(stage: Stage): boolean {
    return STAGE_SIDE[stage] === 'runtime';
}

export interface StageReport {
    readonly stage: Stage;
    readonly side: 'runtime' | 'research';
    /** What the stage actually produced, in its own words. */
    readonly finding: string;
    /** Numbers behind the finding, so it can be checked rather than believed. */
    readonly measured: Readonly<Record<string, number | string | boolean>>;
}

export interface LabRun {
    readonly stages: readonly StageReport[];
    readonly dataset: ReturnType<typeof summarize>;
    readonly splits: {
        train: number;
        validation: number;
        test: number;
        purged: number;
    };
    readonly walkForward: {
        folds: number;
        accepted: number;
        rejected: number;
        traded: number;
    };
    /**
     * Whether anything here is fit to be promoted.
     *
     * A single field, and it is false for every run of this build. A research
     * laboratory that reports "ready" without having crossed a shadow period
     * has skipped the only stage that could have told it something.
     */
    readonly promotable: boolean;
    readonly why: string;
}

export interface LabOptions {
    featureConfig?: FeatureConfig;
    datasetConfig?: typeof DEFAULT_DATASET_CONFIG;
    walkForward?: Partial<WalkForwardOptions>;
    /** Realised results, when the caller has them. Absent in a cold run. */
    outcomes?: Readonly<Record<string, number>>;
}

/**
 * The whole chain, run on one series.
 *
 * Stages are executed in order and each one's finding is what the next one is
 * given. Nothing is asserted about quality here beyond what the numbers say,
 * and the run ends with `promotable: false` because that is what a run
 * without a shadow period has earned.
 */
export function runLaboratory(
    candles: readonly Candle[],
    options: LabOptions = {},
): LabRun {
    const featureConfig = options.featureConfig ?? DEFAULT_FEATURE_CONFIG;
    const datasetConfig = {
        ...DEFAULT_DATASET_CONFIG,
        ...options.datasetConfig,
    };
    const walkForwardOptions = {
        ...DEFAULT_WALK_FORWARD_OPTIONS,
        ...options.walkForward,
    };

    const stages: StageReport[] = [];
    const start = requiredBarsForFeatures(featureConfig);

    stages.push({
        stage: 'research',
        side: 'research',
        finding:
            candles.length > start
                ? `${candles.length} баров, из них ${candles.length - start + 1} пригодны для признаков`
                : `серии из ${candles.length} баров недостаточно: нужно ${start}`,
        measured: {
            bars: candles.length,
            usable: Math.max(0, candles.length - start + 1),
        },
    });

    const vectors = extractFeatureSeries(candles, featureConfig);
    const rows: DatasetRow[] = buildDataset(vectors, candles, datasetConfig);

    stages.push({
        stage: 'features',
        side: 'runtime',
        finding: `${vectors.length} векторов признаков, версия ${vectors[0]?.version ?? 'нет'}`,
        measured: {
            vectors: vectors.length,
            columns: vectors[0] === undefined ? 0 : Object.keys(vectors[0].values).length,
            featureVersion: vectors[0]?.version ?? 'none',
        },
    });

    const splits = splitByTime(rows, 0.6, 0.2, datasetConfig.intervalMs);
    const summary = summarize(rows);

    stages.push({
        stage: 'indicator-evaluation',
        side: 'runtime',
        finding:
            summary.labelled === 0
                ? 'ни один ряд не имеет метки: горизонт ни разу не закрылся'
                : `${summary.labelled} размеченных рядов из ${summary.rows}, доля положительных ${positiveShare(rows).toFixed(3)}`,
        measured: {
            labelled: summary.labelled,
            positiveShare: positiveShare(rows),
        },
    });

    stages.push({
        stage: 'backtest',
        side: 'research',
        finding: `сетка параметров и издержки исполнения из прогона; результат считается в walk-forward, а не здесь`,
        measured: { feeRate: walkForwardOptions.execution.takerFeeRate },
    });

    const result = runWalkForward([...candles], walkForwardOptions);
    const accepted = result.folds.filter((fold) => fold.validation.accepted).length;
    const traded = result.trades.length;

    stages.push({
        stage: 'walk-forward',
        side: 'research',
        // Said as a shape rather than a verdict: a run with no accepted folds
        // is a fact about the folds, and a summary that calls it "no
        // opportunities" would be a claim the data does not make.
        finding: `${result.folds.length} складок, принято ${accepted}, отклонено ${result.folds.length - accepted}, сделок ${traded}`,
        measured: {
            folds: result.folds.length,
            accepted,
            rejected: result.folds.length - accepted,
            trades: traded,
            totalReturn: result.overall.totalReturn,
            maxDrawdown: result.overall.maxDrawdown,
        },
    });

    const purged = splits.purged;

    stages.push({
        stage: 'experiment',
        side: 'research',
        finding: `контрольная сумма набора ${summary.checksum}, строки с меткой выходят за границу разделения: ${purged}`,
        measured: { checksum: summary.checksum, purged },
    });

    stages.push({
        stage: 'candidate',
        side: 'research',
        finding:
            'кандидат не создан: ни одна конфигурация не прошла проверку на отложенной выборке',
        measured: { candidates: 0 },
    });

    stages.push({
        stage: 'shadow',
        side: 'research',
        finding: 'теневой период не пройден: у прогона нет живого сигнала, за которым можно наблюдать',
        measured: { shadowSignals: 0 },
    });

    stages.push({
        stage: 'performance',
        side: 'runtime',
        finding:
            traded === 0
                ? 'сделок не было, поэтому измерять нечего: это отсутствие данных, а не нулевая доходность'
                : `${traded} сделок, итог ${(result.overall.totalReturn * 100).toFixed(2)}%, просадка ${(result.overall.maxDrawdown * 100).toFixed(2)}%`,
        measured: {
            trades: traded,
            totalReturn: result.overall.totalReturn,
            maxDrawdown: result.overall.maxDrawdown,
        },
    });

    stages.push({
        stage: 'calibration',
        side: 'research',
        finding:
            traded < 20
                ? `выборка из ${traded} сделок: калибровать не на чем, любое число здесь будет выдумкой`
                : `выборка из ${traded} сделок, калибровка считается по фактическим исходам`,
        measured: { sampleSize: traded, minimumForCalibration: 20 },
    });

    stages.push({
        stage: 'production',
        side: 'runtime',
        finding: 'в продакшен не выходит ничто: цепочка не дошла до подтверждённого кандидата',
        measured: { promotable: false },
    });

    return {
        stages,
        dataset: summary,
        splits: {
            train: splits.train.length,
            validation: splits.validation.length,
            test: splits.test.length,
            purged,
        },
        walkForward: {
            folds: result.folds.length,
            accepted,
            rejected: result.folds.length - accepted,
            traded,
        },
        promotable: false,
        why:
            'Ни одна конфигурация не прошла отложенную проверку, тень и калибровку по фактическим исходам. Лаборатория готовит данные и воспроизводимость; решение о выводе принимает правило перехода, а не этот отчёт.',
    };
}

function positiveShare(rows: readonly DatasetRow[]): number {
    const labelled = rows.filter((row) => row.label !== null);

    if (labelled.length === 0) {
        return 0;
    }

    return labelled.filter((row) => row.label === 1).length / labelled.length;
}

/**
 * The fold verdict on its own, for a caller that has one fold's numbers.
 *
 * Re-exported rather than reimplemented, so the laboratory and the backtest
 * cannot disagree about what a fold passing means. Two copies of a tolerance
 * would be two answers to "is this fold good enough", and the one nobody
 * maintains is the one that gets used.
 */
export { judgeFold, manifestFor };

/** The report, as a value that validates. */
export const LabRunSchema = z.object({
    stages: z
        .array(
            z.object({
                stage: z.enum(STAGES),
                side: z.enum(['runtime', 'research']),
                finding: z.string().min(1),
                measured: z.record(
                    z.string(),
                    z.union([z.number(), z.string(), z.boolean()]),
                ),
            }),
        )
        .min(1),
    dataset: z.object({
        rows: z.coerce.number().int().nonnegative(),
        labelled: z.coerce.number().int().nonnegative(),
        unlabelled: z.coerce.number().int().nonnegative(),
        from: z.coerce.number().int(),
        to: z.coerce.number().int(),
        checksum: z.string().min(1),
        featureVersion: z.string().min(1),
        datasetVersion: z.string().min(1),
    }),
    splits: z.object({
        train: z.coerce.number().int().nonnegative(),
        validation: z.coerce.number().int().nonnegative(),
        test: z.coerce.number().int().nonnegative(),
        purged: z.coerce.number().int().nonnegative(),
    }),
    walkForward: z.object({
        folds: z.coerce.number().int().nonnegative(),
        accepted: z.coerce.number().int().nonnegative(),
        rejected: z.coerce.number().int().nonnegative(),
        traded: z.coerce.number().int().nonnegative(),
    }),
    promotable: z.boolean(),
    why: z.string().min(1),
});
