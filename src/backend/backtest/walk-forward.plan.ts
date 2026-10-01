import { requiredCandleCount } from '../config/indicator.config.js';

/**
 * The windows a walk-forward is allowed to use, expressed as data.
 *
 * The loop in `runWalkForward` already keeps training and test windows apart,
 * and that is easy to verify by reading it. It is not easy to verify that it
 * keeps doing so after the next three edits, which is when the bug actually
 * arrives: a window that grows by one bar, a start index that becomes a
 * `<=` instead of a `<`, a training range that quietly includes the bar the
 * signal was taken on. None of those look wrong in a diff.
 *
 * So the plan is built first, as a value, and the loop consumes it. The
 * relationships that must hold — ordered, disjoint, the test window strictly
 * after everything the parameters were chosen on — are then assertions over
 * that value rather than a property a reader has to reconstruct from control
 * flow.
 *
 * The warm-up prefix is part of the plan and is explicitly *not* a window. It
 * is the bars the indicators need before they have an opinion, and folding it
 * into training would let a fit be scored on a hundred bars of EMA seed.
 */

export interface Window {
    readonly startIndex: number;
    readonly endIndex: number;
}

export interface FoldPlan {
    readonly fold: number;
    readonly train: Window;
    /**
     * The window used to *reject* parameters, not to choose them.
     *
     * A pair that wins on training and loses on the bar right after it has
     * fitted the noise of the training window, and a run that applies it to
     * test is reporting that noise as a result. The validation window exists
     * so that rejection is a separate, recorded event rather than something a
     * reader has to notice themselves.
     */
    readonly validate: Window;
    readonly test: Window;
}

export interface WalkForwardPlan {
    readonly warmup: Window;
    readonly folds: readonly FoldPlan[];
    /** Bars the run asked for but could not use. */
    readonly skippedFolds: number;
}

/**
 * How the validation window is carved out of the training span.
 *
 * The validation window is *not* extra data: it is the tail of the training
 * span, and the parameters are chosen on the head of it. Taking it from inside
 * the training window rather than after it is what keeps the plan's total
 * length unchanged, so adding a validation stage does not silently shorten
 * every fold's history.
 */
export const DEFAULT_VALIDATION_RATIO = 0.3;

export interface PlanOptions {
    /**
     * Share of the training span held back for validation, 0..1 exclusive.
     *
     * Zero disables the stage and the run becomes a plain train-then-test
     * backtest, which is still useful and no longer says anything about
     * parameter stability. A validation share of one is refused: a fold whose
     * parameters are chosen on nothing is not a validated fold.
     */
    validationRatio?: number;
}

/**
 * The three numbers a plan is shaped by, and nothing else.
 *
 * This is what the plan is, and it is smaller than the run's options on purpose.
 *
 * The function used to accept the whole `WalkForwardOptions` and read three
 * fields off it, which meant this module imported the runner's types and the two
 * of them formed a cycle — the only cycle inside a layer anywhere in the
 * project, and the one the architecture report names. Moving the type to a third
 * file would have made the report go quiet without making the coupling go away.
 *
 * Declaring what is actually used does the opposite. The plan now says it needs
 * three lengths, the runner's options satisfy it, and the direction of the
 * dependency is one way because there is nothing left to point back.
 */
export interface PlanShape {
    /** Length of each evaluation window. */
    readonly foldBars: number;
    /** Length of the window that precedes it and is used for fitting. */
    readonly trainingBars: number;
    /** Evaluated windows to keep, newest first. */
    readonly maxFolds: number;
}

export function buildWalkForwardPlan(
    candleCount: number,
    options: PlanShape,
    planOptions: PlanOptions = {},
): WalkForwardPlan {
    const ratio = planOptions.validationRatio ?? DEFAULT_VALIDATION_RATIO;
    const warmupEnd = requiredCandleCount() - 1;

    if (ratio < 0 || ratio >= 1) {
        throw new Error(
            `Validation share must be below 1, got ${ratio}: a fold whose parameters are chosen on nothing is not a validated fold`,
        );
    }

    const warmup: Window = { startIndex: 0, endIndex: warmupEnd };

    const step = options.foldBars;
    const available = candleCount - warmupEnd - 1 - options.trainingBars;
    const possibleFolds = Math.floor(available / step);
    const foldCount = Math.min(possibleFolds, options.maxFolds);

    const folds: FoldPlan[] = [];

    // Newest fold first, then reversed for the caller, exactly as the runner
    // does. The plan and the run have to visit folds in the same order or the
    // audit is checking a different run from the one being reported.
    for (let offset = 0; offset < foldCount; offset += 1) {
        const testEnd = candleCount - 1 - offset * step;
        const testStart = testEnd - step + 1;
        const trainEnd = testStart - 1;
        const trainStart = Math.max(warmupEnd + 1, trainEnd - options.trainingBars + 1);

        if (testStart < warmupEnd + 1 || trainEnd < trainStart) {
            break;
        }

        // The validation window is the tail of the training span, and the
        // fit runs on what is left of it.
        const trainLength = trainEnd - trainStart + 1;
        const validateLength = Math.max(1, Math.floor(trainLength * ratio));
        const validateStart = trainEnd - validateLength + 1;

        folds.push({
            fold: foldCount - offset,
            train: { startIndex: trainStart, endIndex: validateStart - 1 },
            validate: { startIndex: validateStart, endIndex: trainEnd },
            test: { startIndex: testStart, endIndex: testEnd },
        });
    }

    return {
        warmup,
        // Oldest first, matching what the report prints.
        folds: folds.reverse(),
        skippedFolds: Math.max(0, possibleFolds - foldCount),
    };
}

export interface LeakageFinding {
    readonly fold: number;
    readonly kind:
        /** The test window reaches into the bars the parameters were fitted on. */
        | 'test_overlaps_training'
        /** The validation window is not between training and test. */
        | 'validation_misplaced'
        /** Two windows of one fold share a bar. */
        | 'windows_overlap'
        /** A window reaches back into the warm-up prefix. */
        | 'window_in_warmup'
        /** A window runs past the end of the data that exists. */
        | 'window_past_data';
    readonly detail: string;
}

export interface LeakageAudit {
    readonly findings: readonly LeakageFinding[];
    readonly clean: boolean;
}

function overlaps(left: Window, right: Window): boolean {
    return left.startIndex <= right.endIndex && right.startIndex <= left.endIndex;
}

/**
 * Checks a plan for the four ways walk-forward leaks.
 *
 * Run over the plan the run is about to execute, and again over the plan that
 * did execute, because the interesting failure is the one where the two
 * differ — a plan that is clean and a run that did not follow it.
 */
export function auditWalkForwardPlan(
    plan: WalkForwardPlan,
    candleCount: number,
): LeakageAudit {
    const findings: LeakageFinding[] = [];

    for (const fold of plan.folds) {
        const windows: [string, Window][] = [
            ['train', fold.train],
            ['validate', fold.validate],
            ['test', fold.test],
        ];

        for (const [name, window] of windows) {
            if (window.startIndex > window.endIndex) {
                findings.push({
                    fold: fold.fold,
                    kind: 'validation_misplaced',
                    detail: `${name} window is empty or inverted (${window.startIndex}..${window.endIndex})`,
                });
            }

            if (overlaps(window, plan.warmup)) {
                findings.push({
                    fold: fold.fold,
                    kind: 'window_in_warmup',
                    detail: `${name} window ${window.startIndex}..${window.endIndex} reaches into the warm-up prefix ending at ${plan.warmup.endIndex}`,
                });
            }

            if (window.endIndex > candleCount - 1) {
                findings.push({
                    fold: fold.fold,
                    kind: 'window_past_data',
                    detail: `${name} window ends at ${window.endIndex} but only ${candleCount - 1} bars exist`,
                });
            }
        }

        for (let i = 0; i < windows.length; i += 1) {
            for (let j = i + 1; j < windows.length; j += 1) {
                const [leftName, left] = windows[i]!;
                const [rightName, right] = windows[j]!;

                if (overlaps(left, right)) {
                    findings.push({
                        fold: fold.fold,
                        kind: 'windows_overlap',
                        detail: `${leftName} (${left.startIndex}..${left.endIndex}) and ${rightName} (${right.startIndex}..${right.endIndex}) share bars`,
                    });
                }
            }
        }

        // The specific one walk-forward exists to prevent, checked directly
        // rather than inferred from the general overlap test: the bar a signal
        // is taken on must not be a bar its own parameters were fitted on.
        if (fold.test.startIndex <= fold.train.endIndex) {
            findings.push({
                fold: fold.fold,
                kind: 'test_overlaps_training',
                detail: `test starts at ${fold.test.startIndex} while training runs to ${fold.train.endIndex}`,
            });
        }
    }

    return { findings, clean: findings.length === 0 };
}

export interface ValidationVerdict {
    readonly fold: number;
    readonly accepted: boolean;
    /**
     * Why the pair was kept or dropped, in a sentence.
     *
     * A fold that is dropped without a reason is a fold a reader has to
     * re-derive, and re-deriving it means trusting the same code that made the
     * decision.
     */
    readonly reason: string;
}

/**
 * How much of its edge a fold may lose on validation and still be kept.
 *
 * Set to one round trip of cost rather than to zero, and the reason is
 * arithmetic: a fold is accepted if it does not give up more than the trade
 * would have paid to enter. A zero tolerance would reject every pair whose
 * validation is even fractionally worse than its training, which for a sample
 * of a few hundred bars is most of them — and the run would be left with
 * nothing to trade while the surviving pairs are chosen by which one happened
 * to score marginally higher.
 */
export const DEFAULT_VALIDATION_TOLERANCE = 0.002;

/**
 * Decides whether a fold's fitted parameters survived validation.
 *
 * Acceptance is *not* "validation made money". A pair that loses slightly on
 * the validation window may still be the best of the available ones, and
 * rejecting it for that leaves the run with nothing to trade. What is
 * rejected is a pair whose edge does not survive the bar immediately after
 * the one it was fitted on, which is the signature of having fitted the noise.
 */
export function judgeFold(
    fold: FoldPlan,
    trainingScore: number | null,
    validationScore: number | null,
    tolerance = DEFAULT_VALIDATION_TOLERANCE,
): ValidationVerdict {
    if (trainingScore === null || validationScore === null) {
        return {
            fold: fold.fold,
            accepted: false,
            reason: 'не измерено: подбор или валидация не дали результата',
        };
    }

    if (validationScore < trainingScore - tolerance) {
        return {
            fold: fold.fold,
            accepted: false,
            reason: `на валидации ${validationScore.toFixed(4)} против ${trainingScore.toFixed(4)} на обучении: край выбран по шуму обучающего окна`,
        };
    }

    return {
        fold: fold.fold,
        accepted: true,
        reason: `на валидации ${validationScore.toFixed(4)} не хуже обучающих ${trainingScore.toFixed(4)}`,
    };
}
