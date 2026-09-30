import { describe, expect, it } from 'vitest';

import { describeSearch } from './optimize.report.js';

import type { ScoredCandidate, SearchResult } from './optimizer.js';

function candidate(
    values: Record<string, number>,
    score: number,
    trades: number,
    stability = 0.1,
): ScoredCandidate {
    // `label` is required by the type and I left it out on the first pass; the
    // report happens not to read it, which is exactly the kind of field a test
    // stub quietly drops and then nobody notices is missing anywhere.
    return {
        label: Object.entries(values)
            .map(([key, value]) => `${key}=${value}`)
            .join(','),
        values,
        score,
        trades,
        stability,
    };
}

function search(over: Partial<SearchResult> = {}): SearchResult {
    const ranked = over.ranked ?? [
        candidate({ threshold: 1 }, 0.02, 40),
        candidate({ threshold: 2 }, 0.018, 38),
    ];

    return {
        best: ranked[0] ?? null,
        ranked,
        evaluated: 200,
        gridSize: 200,
        inert: 20,
        window: { startIndex: 0, endIndex: 500 },
        ...over,
    };
}

const market = { instrument: 'BTCUSDT', interval: '1d', candles: 900 };
const window = { startIndex: 0, endIndex: 500 };

/**
 * What the report is for.
 *
 * A search that prints its winner invites the reader to believe the winner. The
 * text therefore has to make the reader suspicious: how much of the grid was
 * worth scoring, whether the winner's neighbours are close behind, and the
 * spike verdict last. These tests check that a report cannot quietly drop any
 * of the three.
 */
describe('the search report makes its reader suspicious', () => {
    it('leads with how much of the grid was worth scoring', () => {
        const text = describeSearch({ result: search({ inert: 180 }), market, window });

        // 180 of 200 never traded: the winner was chosen from a fifth of the
        // grid, and a report that led with the winning number would hide that.
        expect(text).toContain('Оценено точек: 200 из 200');
        expect(text).toContain('Из них без единой сделки: 180 (90.00%)');
    });

    it('says when the grid was cut short, rather than letting a short search read as a full one', () => {
        const text = describeSearch({
            result: search({ evaluated: 400, gridSize: 12_000 }),
            market,
            window,
        });

        expect(text).toContain('Оценено точек: 400 из 12000');
        expect(text).toContain('обрезано лимитом');
    });

    it('shows the neighbourhood, not the champion alone', () => {
        // A ranking whose neighbours are invisible cannot be checked for a
        // spike, and the spike check is the only defence this system has.
        const text = describeSearch({ result: search(), market, window });

        expect(text).toContain('Рейтинг:');
        expect(text).toContain('threshold=1');
        expect(text).toContain('threshold=2');
    });

    it('ends on the spike verdict and says what to do about it', () => {
        const text = describeSearch({ result: search(), market, window });

        expect(text.indexOf('ПРОВЕРКА НА ПИК')).toBeGreaterThan(
            text.indexOf('Рейтинг:'),
        );
        expect(text).toContain('Пик:');
        expect(text).toContain('гипотеза, а не правило');
    });

    it('refuses to invent a conclusion when nothing traded', () => {
        // The empty case matters more than it looks: a report that fell through
        // to "best point" formatting would print a best of `null` as a
        // percentage, which is the shape of a number nobody checked.
        const text = describeSearch({
            result: search({ best: null, ranked: [], evaluated: 200, inert: 200 }),
            market,
            window,
        });

        expect(text).toContain('Ни одна точка сетки не дала сделок');
        expect(text).not.toContain('Лучшая точка');
        expect(text).not.toContain('ПРОВЕРКА НА ПИК');
    });

    it('refuses to call a losing winner a hypothesis worth carrying forward', () => {
        // **Found by running it, not by reading it.** A real search produced a
        // winner of −0.12% per trade that passed the spike check comfortably —
        // its neighbours are just as losing, so the peak test had nothing to
        // object to. The old ending said "это гипотеза, а не правило" after a
        // passing check, which reads as a green light.
        //
        // "Not a spike" means the number is not an artefact. It says nothing
        // about the number being positive, and the two were being reported in
        // the same breath.
        const text = describeSearch({
            result: search({
                best: candidate({ threshold: 1 }, -0.0012, 28),
                ranked: [candidate({ threshold: 1 }, -0.0012, 28)],
            }),
            market,
            window,
        });

        expect(text).toContain('лучшая точка убыточна');
        expect(text).toContain('Проверка на пик этого не ловит');
        expect(text).not.toContain('гипотеза, а не правило');
    });

    it('truncates a long ranking without pretending it is short', () => {
        const ranked = Array.from({ length: 40 }, (_, index) =>
            candidate({ threshold: index + 1 }, 0.02 - index / 1_000, 40 - index),
        );
        const text = describeSearch({ result: search({ ranked }), market, window });

        expect(text).toContain('…ещё 30');
    });
});
