import { consensusConfig } from '../config/consensus.config.js';

import type { IndicatorAnalysis, IndicatorSignal, SignalResult } from './signal.types.js';
import type {
    ConfidenceModel,
    ConsensusConfig,
    WeightModel,
} from '../config/consensus.config.js';

/** Two-sided 95% quantile of the standard normal distribution. */
const Z_95 = 1.959963985;

/**
 * Votes are continuous, so the binomial counts are scaled up before the
 * interval is computed. This keeps the bound finite when only a fraction of
 * an indicator's strength is in play.
 */
const WEIGHT_SCALE = 100;

export function clampWeight(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.min(1, Math.max(0, value));
}

/**
 * Lower bound of the Wilson score interval: the pessimistic end of the range
 * that is compatible with the votes cast. It is reported instead of the raw
 * share so a two-to-one split cannot be presented as two thirds certainty.
 */
export function wilsonLowerBound(
    successes: number,
    trials: number,
    z: number = Z_95,
): number {
    if (trials <= 0) {
        return 0;
    }

    const p = successes / trials;
    const denominator = 1 + z * z / trials;
    const centre = p + z * z / (2 * trials);
    const margin = z * Math.sqrt(
        (p * (1 - p)) / trials + (z * z) / (4 * trials * trials),
    );

    return Math.max(0, Math.min(1, (centre - margin) / denominator));
}

/**
 * What one agreeing indicator contributes under the configured weight model.
 *
 * Every model is monotonic in strength — a stronger vote is never worth less —
 * because the one property that must hold regardless of configuration is that
 * the panel can tell a decisive indicator from a marginal one.
 */
function weightOf(raw: number, model: WeightModel): number {
    const weight = clampWeight(raw);

    switch (model) {
        case 'continuous':
            return weight;
        case 'binary':
            // A vote that made it past its own threshold counts once. Zero stays
            // zero, so an abstaining indicator is still excluded.
            return weight > 0 ? 1 : 0;
        case 'sqrt':
            return Math.sqrt(weight);
    }
}

function confidenceOf(
    winningWeight: number,
    losingWeight: number,
    meanConviction: number,
    model: ConfidenceModel,
): number {
    const totalWeight = winningWeight + losingWeight;

    switch (model) {
        case 'wilson':
            return Math.round(
                wilsonLowerBound(
                    winningWeight * WEIGHT_SCALE,
                    totalWeight * WEIGHT_SCALE,
                ) * 100,
            );
        case 'share':
            return Math.round((winningWeight / totalWeight) * 100);
        case 'mean_conviction':
            return Math.round(meanConviction * 100);
    }
}

/**
 * The panel, split by what each indicator did relative to the verdict.
 *
 * This is the structure the published reason and the published explanation are
 * both generated from, which is what makes them incapable of disagreeing: there
 * is one partition, and two renderings of it.
 */
export interface SignalPanel {
    readonly supporting: readonly IndicatorAnalysis[];
    readonly opposing: readonly IndicatorAnalysis[];
    readonly abstaining: readonly IndicatorAnalysis[];
}

export function partitionPanel(
    analyses: readonly IndicatorAnalysis[],
    direction: IndicatorSignal,
): SignalPanel {
    return {
        supporting:
            direction === 'NEUTRAL'
                ? []
                : analyses.filter((analysis) => analysis.signal === direction),
        opposing:
            direction === 'NEUTRAL'
                ? []
                : analyses.filter(
                      (analysis) =>
                          analysis.signal !== direction &&
                          analysis.signal !== 'NEUTRAL',
                  ),
        abstaining: analyses.filter(
            (analysis) => analysis.signal === 'NEUTRAL',
        ),
    };
}

/**
 * The Russian sentence the dashboard shows.
 *
 * Generated from the panel rather than assembled next to it. Two strings
 * describing the same verdict, built in two places, disagree the first time
 * either is edited — and the disagreement would be between the sentence a
 * person reads and the arithmetic behind it, which is the one thing that must
 * never differ.
 */
export function describeSignal(
    panel: SignalPanel,
    direction: IndicatorSignal,
    reason: string,
): string {
    if (direction === 'NEUTRAL' || panel.supporting.length === 0) {
        return reason;
    }

    const names = panel.supporting.map((analysis) => analysis.name);
    const verb = names.length === 1 ? 'подтверждает' : 'подтверждают';
    const only =
        panel.abstaining.length > 0 && panel.opposing.length === 0
            ? 'Только '
            : '';

    return `${only}${joinRussian(names)} ${verb} ${direction}`;
}

function joinRussian(names: readonly string[]): string {
    if (names.length === 0) {
        return '';
    }

    if (names.length === 1) {
        return names[0] ?? '';
    }

    return `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`;
}

function tally(
    analyses: readonly IndicatorAnalysis[],
    signal: 'LONG' | 'SHORT',
    model: WeightModel,
): { count: number; weight: number; weighted: number } {
    let count = 0;
    let weight = 0;
    let weighted = 0;

    for (const analysis of analyses) {
        if (analysis.signal !== signal) {
            continue;
        }

        count += 1;
        const own = weightOf(analysis.weight, model);
        weight += own;
        // An indicator that leans this way but assigns the lean no conviction is
        // not a vote for it. `analyzeEMA` returns LONG with weight 0 whenever
        // price sits on the EMA, which is an ordinary reading, so this is a
        // shape the panel takes routinely rather than a corner case.
        if (own > 0) {
            weighted += 1;
        }
    }

    return { count, weight, weighted };
}

/**
 * Turns a panel of opinions into one published signal, under a configuration.
 *
 * The three floors are checked in the order a reader would apply them: is
 * there a disagreement, is there agreement, is that agreement worth anything.
 * Each one that fails reports which, because "NEUTRAL, confidence 0" on its own
 * does not tell anybody whether the panel split, did not agree, or agreed
 * feebly — and those are three different situations with three different
 * things to do next.
 */
export function calculateConsensus(
    analyses: readonly IndicatorAnalysis[],
    config: ConsensusConfig = consensusConfig,
): Omit<SignalResult, 'indicators'> {
    const long = tally(analyses, 'LONG', config.weightModel);
    const short = tally(analyses, 'SHORT', config.weightModel);

    // An abstaining indicator is excluded from the trial count rather than
    // counted as a vote against: NEUTRAL means "no opinion", and letting a
    // stray weight leak in would silently dilute a real consensus.
    if (long.count === short.count) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason: long.count > 0
                ? 'Индикаторы дают противоположные сигналы'
                : 'Ни один индикатор не даёт сигнала',
        };
    }

    const winningSignal = long.count > short.count ? 'LONG' : 'SHORT';
    const winning = winningSignal === 'LONG' ? long : short;
    const losing = winningSignal === 'LONG' ? short : long;
    const panel = partitionPanel(analyses, winningSignal);
    const winningNames = panel.supporting.map((analysis) => analysis.name);

    // A single indicator is an opinion, not a consensus — and an indicator that
    // put no conviction behind its lean is not even that. Counting those would
    // let one reading carry a panel to the threshold on its own, and the rule's
    // own words — "2 of 3, one indicator is an opinion" — would mean something
    // different at the moment it mattered most.
    if (winning.weighted < config.minimumAgreeing) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason: `Нет большинства: только ${joinRussian(winningNames)} за ${winningSignal}`,
        };
    }

    if (winning.weight + losing.weight <= 0) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason: 'Ни один индикатор не даёт сигнала',
        };
    }

    // Divided by the votes that carry conviction, not by every analysis that
    // happened to lean the same way. Counting a zero against the average is how
    // a panel that agrees on direction but not on strength ends up reporting
    // lower conviction than the indicators that actually spoke.
    const meanConviction = winning.weight / winning.weighted;

    if (meanConviction < config.minimumMeanConviction) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason: `${joinRussian(winningNames)} едва подтверждают ${winningSignal}`,
        };
    }

    // The fallback for the floors: "barely confirms", "no majority". Those
    // describe a verdict that was not published rather than a panel that did,
    // and the published path renders its sentence from the panel instead.
    const floorReason = `${joinRussian(winningNames)} едва подтверждают ${winningSignal}`;

    return {
        signal: winningSignal,
        confidence: confidenceOf(
            winning.weight,
            losing.weight,
            meanConviction,
            config.confidenceModel,
        ),
        reason: describeSignal(panel, winningSignal, floorReason),
    };
}
