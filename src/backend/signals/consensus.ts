import type { IndicatorAnalysis, SignalResult } from './signal.types.js';

/** Two-sided 95% quantile of the standard normal distribution. */
const Z_95 = 1.959963985;

/**
 * Votes are continuous, so the binomial counts are scaled up before the
 * interval is computed. This keeps the bound finite when only a fraction of
 * an indicator's strength is in play.
 */
const WEIGHT_SCALE = 100;

/** A direction needs more than half of the indicators to agree. */
const MINIMUM_AGREEING_INDICATORS = 2;

/**
 * Mean conviction of the agreeing indicators below which the direction is not
 * published at all.
 *
 * The Wilson bound compares ratios, so scaling every weight down leaves it
 * untouched: three indicators that cleared their thresholds by a hair would
 * otherwise report the same 99% as three decisive ones. The floor closes that
 * gap, and it only fires on readings no sane configuration produces for a real
 * signal.
 */
const MINIMUM_MEAN_CONVICTION = 0.25;

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
        p * (1 - p) / trials + (z * z) / (4 * trials * trials),
    );

    return Math.max(0, Math.min(1, (centre - margin) / denominator));
}

function joinRussian(names: string[]): string {
    if (names.length === 0) {
        return '';
    }

    if (names.length === 1) {
        return names[0] ?? '';
    }

    return `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`;
}

function tally(
    analyses: IndicatorAnalysis[],
    signal: 'LONG' | 'SHORT',
): { count: number; weight: number } {
    let count = 0;
    let weight = 0;

    for (const analysis of analyses) {
        if (analysis.signal !== signal) {
            continue;
        }

        count += 1;
        weight += clampWeight(analysis.weight);
    }

    return { count, weight };
}

export function calculateConsensus(
    analyses: IndicatorAnalysis[],
): Omit<SignalResult, 'indicators'> {
    const long = tally(analyses, 'LONG');
    const short = tally(analyses, 'SHORT');
    const neutralCount = analyses.filter(
        (analysis) => analysis.signal === 'NEUTRAL',
    ).length;

    // An abstaining indicator is excluded from the trial count rather than
    // counted as a vote against: NEUTRAL means "no opinion", and letting a
    // stray weight leak in would silently dilute a real consensus.
    const totalWeight = long.weight + short.weight;

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
    const winningNames = analyses
        .filter(
            (analysis) =>
                analysis.signal === winningSignal,
        )
        .map(
            (analysis) => analysis.name,
        );

    // A single indicator is an opinion, not a consensus. Reporting it as a
    // 33% LONG used to be the most common state of the dashboard.
    if (winning.count < MINIMUM_AGREEING_INDICATORS) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason: `Нет большинства: только ${joinRussian(winningNames)} за ${winningSignal}`,
        };
    }

    if (totalWeight <= 0) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason: 'Ни один индикатор не даёт сигнала',
        };
    }

    const meanConviction = winning.weight / winning.count;

    if (meanConviction < MINIMUM_MEAN_CONVICTION) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason: `${joinRussian(winningNames)} едва подтверждают ${winningSignal}`,
        };
    }

    const confidence = Math.round(
        wilsonLowerBound(
            winning.weight * WEIGHT_SCALE,
            totalWeight * WEIGHT_SCALE,
        ) * 100,
    );

    const verb = winning.count === 1
        ? 'подтверждает'
        : 'подтверждают';

    const only = neutralCount > 0 && losing.count === 0
        ? 'Только '
        : '';

    return {
        signal: winningSignal,
        confidence,
        reason: `${only}${joinRussian(winningNames)} ${verb} ${winningSignal}`,
    };
}
