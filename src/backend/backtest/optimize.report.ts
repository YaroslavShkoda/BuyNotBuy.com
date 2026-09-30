/**
 * The parameter search, rendered as text.
 *
 * **A separate module because a CLI is not a function.** Every reporter in this
 * project that can be checked without starting a process lives beside its
 * command rather than inside it, and the reason is the import: a `main()` at
 * the bottom of a file runs when a test imports the reporter out of it, so the
 * test would fetch candles from an exchange to check a string.
 *
 * The output is shaped around the way a grid search lies. A search that prints
 * its winner invites the reader to believe the winner; so the count of points
 * that never traded comes first, the neighbourhood is printed rather than the
 * champion alone, and `detectSpike` has the last word.
 */

import { detectSpike } from './optimizer.js';

import type { SearchResult, ScoredCandidate } from './optimizer.js';

/**
 * How many candidates to print.
 *
 * A wall of two hundred rows is not a list anybody compares, and the
 * neighbourhood is the point — the spike check reads the winner's neighbours,
 * so showing only the top of the ranking shows exactly the part that says least
 * about whether the winner is real.
 */
export const SHOWN = 10;

function percent(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
}

function describeValues(values: Record<string, number>): string {
    return Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
}

function row(rank: number, candidate: ScoredCandidate): string {
    const trades = candidate.trades === 0 ? 'нет сделок' : `${candidate.trades} сделок`;

    return (
        `  ${String(rank).padStart(2)}. ${describeValues(candidate.values)}` +
        ` → ${percent(candidate.score)} (${trades}), разброс по окнам ${candidate.stability.toFixed(4)}`
    );
}

export interface SearchReportInput {
    readonly result: SearchResult;
    readonly market: { instrument: string; interval: string; candles: number };
    readonly window: { startIndex: number; endIndex: number };
    readonly minimumRetention?: number;
}

export function describeSearch(input: SearchReportInput): string {
    const { result, market, window } = input;
    const spike = detectSpike(
        result,
        undefined,
        input.minimumRetention ?? 0.5,
    );

    const lines: string[] = [];

    lines.push('=== ПОИСК ПАРАМЕТРОВ ===');
    lines.push(
        `Рынок: ${market.instrument} ${market.interval}, свечей ${market.candles}, ` +
            `окно поиска [${window.startIndex}, ${window.endIndex})`,
    );

    // How much of the grid was worth scoring. A search where most points never
    // traded is a search that mostly measured a threshold nothing ever crossed,
    // and a winner chosen out of the few that did is chosen out of a sample
    // nobody sized.
    lines.push(
        `Оценено точек: ${result.evaluated} из ${result.gridSize}` +
            (result.gridSize > result.evaluated ? ' (обрезано лимитом)' : ''),
    );
    lines.push(
        `Из них без единой сделки: ${result.inert}` +
            (result.evaluated > 0 ? ` (${percent(result.inert / result.evaluated)})` : ''),
    );

    if (result.best === null) {
        lines.push('');
        lines.push('Ни одна точка сетки не дала сделок. Искать нечего.');

        return lines.join('\n');
    }

    lines.push('');
    lines.push(
        `Лучшая точка: ${describeValues(result.best.values)} → ${percent(result.best.score)}`,
    );
    lines.push('');
    lines.push('Рейтинг:');

    for (const [index, candidate] of result.ranked.slice(0, SHOWN).entries()) {
        lines.push(row(index + 1, candidate));
    }

    if (result.ranked.length > SHOWN) {
        lines.push(`  …ещё ${result.ranked.length - SHOWN}`);
    }

    lines.push('');
    lines.push('--- ПРОВЕРКА НА ПИК ---');
    lines.push(`Пик: ${spike.spike ? 'ДА' : 'нет'}`);
    lines.push(`Причина: ${spike.reason}`);

    if (spike.neighbourRetention !== null) {
        lines.push(
            `Лучший сосед сохраняет ${percent(spike.neighbourRetention)} результата` +
                (spike.neighbours === 0
                    ? ' (соседей нет — сравнивать не с чем)'
                    : ` из ${spike.neighbours} соседей`),
        );
    }

    lines.push('');

    // **Passing the spike check is not the same as being any good.** Running
    // this for real produced a winner of −0.12% per trade that passed the spike
    // check comfortably — its neighbours are just as losing, so the peak test
    // found nothing to object to. "Not a spike" says the number is not an
    // artefact; it says nothing about the number being positive.
    //
    // A report that ended on "this is a hypothesis" after a passing check would
    // read as a green light, and the reader would have to know this distinction
    // to avoid taking it as one.
    if (result.best.score <= 0) {
        lines.push(
            `Вывод: лучшая точка убыточна (${percent(result.best.score)} на сделку). ` +
                'Проверка на пик этого не ловит: она ищет подгонку, а не прибыль.',
        );
        lines.push('Искать дальше по этой сетке бессмысленно.');

        return lines.join('\n');
    }

    if (spike.spike) {
        lines.push('Вывод: это, скорее всего, подгонка под историю, а не рабочая точка.');
        lines.push('Дальше по лестнице идти не с чем.');
    } else {
        lines.push(
            'Вывод: это гипотеза, а не правило. Дальше — walk-forward, shadow, ' +
                'и только потом решение человека.',
        );
    }

    return lines.join('\n');
}
