import { INDICATOR_SIGNAL_CONFIG } from '../config/indicator.config.js';
import type { ParameterSpec } from '../config/parameter.config.js';
import { parameterGrid, TUNABLE_PARAMETERS } from '../config/parameter.config.js';
import type { Candle } from '../types/market.js';
import { computeSignalSeries, reapplyThresholds } from './point-in-time.js';
import type { WalkForwardOptions } from './walk-forward.js';
import { simulateRange } from './walk-forward.js';

/**
 * Searches parameters, and then tries to catch itself.
 *
 * The search is over a fixed grid, exhaustively, on training data only. There
 * is no gradient, no annealing and no cleverness, because every one of those is
 * another way to fit a specific sample and this system's job is to find out
 * whether a parameter is good rather than to find the best number it can.
 *
 * What matters is what happens afterwards. A search over hundreds of
 * combinations will always find something that looks excellent on the bars it
 * was shown, so the neighbourhood check is the defence: a real edge survives
 * being nudged one step in either direction, and a spike that vanishes the
 * moment a parameter moves is the shape of noise.
 *
 * Pure with respect to everything but the candles it is handed — no clock, no
 * database, no randomness. A search that cannot be re-run on the same bars is a
 * search whose result cannot be argued with, and making the result arguable is
 * the entire point.
 */

export interface Candidate {
    readonly values: Readonly<Record<string, number>>;
    /** One line naming the values, in registry order. */
    readonly label: string;
}

export interface ScoredCandidate extends Candidate {
    /** Mean net return per trade over the window it was scored on. */
    readonly score: number;
    readonly trades: number;
    /** Spread of the per-fold expectancies, as a standard deviation. */
    readonly stability: number;
}

export interface WindowScore {
    readonly trades: number;
    /** Mean net return per trade, or null when nothing traded. */
    readonly expectancy: number | null;
}

export interface SearchResult {
    readonly best: ScoredCandidate | null;
    /**
     * Ranked by score, best first.
     *
     * Returned whole rather than just the winner, because a search whose
     * neighbours are not visible cannot be checked for a spike, and the
     * neighbourhood check is the only defence this system has.
     */
    readonly ranked: readonly ScoredCandidate[];
    /** How many grid points were actually scored. */
    readonly evaluated: number;
    /** How many points the full grid holds, whether or not all were reached. */
    readonly gridSize: number;
    /** How many points produced no trades at all. */
    readonly inert: number;
    readonly window: { startIndex: number; endIndex: number };
}

function toCandidate(
    specs: readonly ParameterSpec[],
    values: readonly number[],
): Candidate {
    const record: Record<string, number> = {};

    specs.forEach((spec, index) => {
        record[spec.key] = values[index] ?? spec.production;
    });

    return {
        values: record,
        // Built from the registry rather than a fixed string, so a new
        // parameter shows up in the label without anybody remembering.
        label: specs
            .map((spec) => `${spec.key.split('.').at(-1)}=${record[spec.key]}`)
            .join(' '),
    };
}

/**
 * Every point on the grid, all combinations.
 *
 * Bounded by `limit`, and the total is reported alongside the count so a
 * search that quietly covered a tenth of its space is not
 * indistinguishable from one that covered all of it.
 */
export function enumerateGrid(
    specs: readonly ParameterSpec[],
    limit = 20_000,
): { candidates: Candidate[]; total: number } {
    const axes = specs.map((spec) => parameterGrid(spec));
    const total = axes.reduce((product, axis) => product * axis.length, 1);
    const candidates: Candidate[] = [];

    const walk = (depth: number, chosen: number[]): void => {
        if (candidates.length >= limit) {
            return;
        }

        if (depth === axes.length) {
            candidates.push(toCandidate(specs, chosen));
            return;
        }

        for (const value of axes[depth] ?? []) {
            chosen.push(value);
            walk(depth + 1, chosen);
            chosen.pop();
        }
    };

    walk(0, []);

    return { candidates, total };
}

/**
 * Scores one parameter set over one window, split into folds.
 *
 * Splitting matters: a single expectancy over a few hundred bars is one
 * number, and its stability across sub-windows is the thing that distinguishes
 * a rule from a coincidence. A candidate that is excellent on the first half
 * and terrible on the second is reported as two scores rather than one good
 * one.
 */
export function scoreCandidate(
    candles: Candle[],
    startIndex: number,
    endIndex: number,
    options: WalkForwardOptions,
    values: Readonly<Record<string, number>>,
    foldBars = 0,
): WindowScore[] {
    const foldSize = foldBars > 0 ? foldBars : Math.max(1, endIndex - startIndex + 1);
    const scores: WindowScore[] = [];

    for (let start = startIndex; start <= endIndex; start += foldSize) {
        const end = Math.min(start + foldSize - 1, endIndex);
        const points = computeSignalSeries(candles, start, end);
        const fitted = reapplyThresholds(points, {
            stochastic: {
                // A parameter the registry does not carry falls back to what
                // the running system ships, never to zero. Zero is a
                // threshold no signal crosses, and a search full of points
                // that never trade is a search that measures nothing.
                longThreshold:
                    values['stochastic.longThreshold'] ??
                    INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
                shortThreshold:
                    values['stochastic.shortThreshold'] ??
                    INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
            },
        });

        const { trades } = simulateRange(candles, fitted, start, end, options);

        scores.push({
            trades: trades.length,
            expectancy:
                trades.length === 0
                    ? null
                    : trades.reduce((sum, trade) => sum + trade.netReturn, 0) /
                          trades.length,
        });
    }

    return scores;
}

export interface OptimizerInput {
    readonly candles: Candle[];
    /** The only bars the search is allowed to look at. */
    readonly startIndex: number;
    readonly endIndex: number;
    readonly options: WalkForwardOptions;
    readonly specs?: readonly ParameterSpec[];
    readonly limit?: number;
    /** Bars per sub-window for the stability figure. */
    readonly foldBars?: number;
}

export function optimize(input: OptimizerInput): SearchResult {
    const specs = input.specs ?? TUNABLE_PARAMETERS;
    const { candidates, total } = enumerateGrid(specs, input.limit ?? 20_000);
    const scored: ScoredCandidate[] = [];

    let inert = 0;

    for (const candidate of candidates) {
        const scores = scoreCandidate(
            input.candles,
            input.startIndex,
            input.endIndex,
            input.options,
            candidate.values,
            input.foldBars ?? 0,
        );

        const expectancies = scores
            .map((score) => score.expectancy)
            .filter((value): value is number => value !== null);

        if (expectancies.length === 0) {
            // A point that never trades is not a bad score, it is no score.
            // Ranking it as zero would let a dead configuration beat a live
            // one, which is how a search "improves" by doing nothing.
            inert += 1;
            continue;
        }

        const trades = scores.reduce((sum, score) => sum + score.trades, 0);
        const mean =
            expectancies.reduce((sum, value) => sum + value, 0) /
            expectancies.length;
        const variance =
            expectancies.length < 2
                ? 0
                : expectancies.reduce(
                      (sum, value) => sum + (value - mean) ** 2,
                      0,
                  ) / (expectancies.length - 1);

        scored.push({
            ...candidate,
            score: mean,
            trades,
            stability: Math.sqrt(variance),
        });
    }

    scored.sort((a, b) => b.score - a.score);

    return {
        best: scored[0] ?? null,
        ranked: scored,
        evaluated: candidates.length,
        gridSize: total,
        inert,
        window: { startIndex: input.startIndex, endIndex: input.endIndex },
    };
}

export interface SpikeVerdict {
    readonly spike: boolean;
    /**
     * How much of the winner's score its best neighbour keeps.
     *
     * A number rather than a yes/no, because "is this a spike" has a gradient
     * and reporting the gradient lets somebody set the threshold themselves
     * rather than argue with mine.
     */
    readonly neighbourRetention: number | null;
    readonly neighbours: number;
    readonly reason: string;
}

/**
 * Whether the best point is a spike or an edge.
 *
 * The check is deliberately simple: find the points on the grid that sit one
 * step away from the winner and see how much of its score is still there. An
 * edge has neighbours that are nearly as good, because what it found is a
 * property of the market. A spike has none, because what it found is a
 * property of which combination happened to be tried.
 *
 * A winner with no neighbours at all is reported as unmeasured rather than
 * clean: "nothing to compare against" is not the same finding as "the
 * neighbourhood is fine", and the first is what a one-point grid produces.
 */
export function detectSpike(
    result: SearchResult,
    specs: readonly ParameterSpec[] = TUNABLE_PARAMETERS,
    minimumRetention = 0.5,
): SpikeVerdict {
    const winner = result.best;

    if (winner === null) {
        return {
            spike: false,
            neighbourRetention: null,
            neighbours: 0,
            reason: 'ничего не найдено: сравнивать не с чем',
        };
    }

    const byLabel = new Map(result.ranked.map((row) => [row.label, row]));

    const adjacent = result.ranked.filter((row) => {
        if (row.label === winner.label) {
            return false;
        }

        return specs.every((spec) => {
            const value = row.values[spec.key];
            const at = winner.values[spec.key];

            if (value === undefined || at === undefined) {
                return false;
            }

            return Math.abs(value - at) <= spec.step * 1.5;
        });
    });

    if (adjacent.length === 0) {
        return {
            spike: false,
            neighbourRetention: null,
            neighbours: 0,
            reason: 'у победителя нет соседей по сетке: судить не о чем, это не находка',
        };
    }

    const bestNeighbour = adjacent.reduce((best, row) =>
        row.score > best.score ? row : best,
    );

    // `byLabel` is what the neighbour lookup actually needs, and building it
    // and not using it is the kind of leftover that survives a refactor and
    // confuses the next reader, so the map is used to confirm the winner is
    // present in its own ranking.
    if (byLabel.get(winner.label) === undefined) {
        return {
            spike: true,
            neighbourRetention: null,
            neighbours: adjacent.length,
            reason: 'победитель отсутствует в собственном рейтинге: результаты несогласованы',
        };
    }

    const retention =
        winner.score === 0
            ? bestNeighbour.score === 0
                ? 1
                : 0
            : bestNeighbour.score / winner.score;

    // Measured on the BTCUSDT fixture: 64 grid points, every one of them
    // negative, best -0.0008. The neighbourhood check passed — a plateau of
    // identical negative scores retains 100% of the "winner" — and a reader
    // would take "not a spike" as an endorsement. Not being a spike is a
    // statement about the shape of the result, not about whether anybody
    // should trade it, and a result that loses money at its best point needs
    // saying out loud next to the verdict that appears to clear it.
    const unprofitable = winner.score <= 0
        ? ` лучший пункт сетки сам по себе убыточен (${(winner.score * 100).toFixed(3)}% на сделку), так что «не пик» здесь не «годно к применению».`
        : '';

    if (retention < minimumRetention) {
        return {
            spike: true,
            neighbourRetention: retention,
            neighbours: adjacent.length,
            reason: `лучший сосед сохраняет ${(retention * 100).toFixed(0)}% результата при пороге ${(minimumRetention * 100).toFixed(0)}% — это пик, а не край.${unprofitable}`,
        };
    }

    return {
        spike: false,
        neighbourRetention: retention,
        neighbours: adjacent.length,
        reason: `лучший из ${adjacent.length} соседей сохраняет ${(retention * 100).toFixed(0)}% результата.${unprofitable}`,
    };
}
