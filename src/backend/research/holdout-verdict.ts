import { query } from '../db/pool.js';
import { holdoutStatus, HOLDOUT_MINIMUM_BARS } from './holdout.js';
import { isKnownMetric, protocolFingerprint } from './holdout-protocol.js';

import type { EvaluationCandidate } from './holdout.js';
import type { HoldoutProtocol, Verdict } from './holdout-protocol.js';
import type { Candle } from '../types/market.js';

/**
 * The write that ends the window.
 *
 * **This function is the missing piece the schema was built for.** Migration 14
 * gives `holdout_verdict` a table that can hold exactly one row, ever —
 * `CHECK (id = 1)` plus the primary key — so that a second read fails in the
 * database instead of in a reader's memory. `lifecycle/holdout-verdict.test.ts`
 * measures both halves of that lock against bad input, and its own header says
 * the reason it exists while nothing writes: "the writer is the missing piece,
 * not the lock". Nothing wrote it. The guarantee was therefore untested in
 * practice — a lock nobody opens, held by a table nothing filled.
 *
 * So the discipline was never enforced where it could be. Writing the verdict is
 * the one moment the protocol can be checked mechanically, and this does all four
 * checks at that moment instead of trusting the reader to have done them:
 *
 * 1. **The window is full.** `holdout_verdict_has_bars` only checks `bar_count >
 *    0`, which a single bar satisfies. The *rule* is `HOLDOUT_MINIMUM_BARS`, and
 *    the rule is ours to enforce — the schema cannot know it.
 * 2. **The readings are complete.** Every declared metric, for every rule. A
 *    partial write is the loophole the migration comment names, and the schema's
 *    `jsonb_typeof(readings) = 'array'` check cannot see inside the array.
 * 3. **Every reading is a declared metric.** A key outside the closed set means
 *    the question was widened at reporting time, which is precisely the failure
 *    `holdout.ts` says the closed set exists to prevent.
 * 4. **The window has not been read.** A second insert hits the primary key, and
 *    that is caught and re-thrown as something a person can act on rather than a
 *    raw constraint name.
 *
 * **Nothing here re-reads the data and nothing is filtered.** The caller supplies
 * the complete output; this checks that it is complete and seals it whole. A
 * writer that accepted "just the profit factor" would be the same hole with a
 * database round trip in front of it.
 */
export interface SealHoldoutInput {
    /** Bars of the held-out window, in the order the reader received them. */
    readonly candles: readonly Candle[];
    /** The protocol as it stood for this read. Stored so a later reshuffle shows. */
    readonly protocol: HoldoutProtocol;
    /** The complete output of `evaluateProtocol` — every rule, every metric. */
    readonly readings: readonly Verdict[];
    /** The registered rules and their registration fingerprints. */
    readonly candidates: readonly EvaluationCandidate[];
    readonly now?: number;
}

export interface SealedHoldoutVerdict {
    readonly id: 1;
    readonly createdAt: number;
    readonly protocolFingerprint: string;
    readonly metrics: readonly string[];
    readonly readings: readonly Verdict[];
    readonly candidates: readonly EvaluationCandidate[];
    readonly firstBarAt: number;
    readonly lastBarAt: number;
    readonly barCount: number;
}

interface VerdictRow {
    id: number;
    created_at: string;
    protocol_fingerprint: string;
    protocol_metrics: string;
    protocol_note: string;
    readings: Verdict[];
    candidates: EvaluationCandidate[];
    first_bar_at: string;
    last_bar_at: string;
    bar_count: number;
}

/**
 * True when the failure is the schema refusing a second verdict row.
 *
 * `23505` is `unique_violation`; the two constraint names are the ones migration 14
 * creates, and both are checked because they refuse different mistakes — the
 * primary key refuses a duplicate `id`, the `CHECK` refuses any `id` at all except
 * 1. Naming one of them is how this function says which of the two it hit.
 */
function violatesHoldoutSingleton(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
        return false;
    }

    const { code, constraint } = error as { code?: unknown; constraint?: unknown };

    return (
        code === '23505' &&
        (constraint === 'holdout_verdict_pkey' ||
            constraint === 'holdout_verdict_singleton')
    );
}

/** The window's bounds, in the one order a reader could not have chosen. */
function windowOf(candles: readonly Candle[]): {
    firstBarAt: number;
    lastBarAt: number;
} {
    const ordered = [...candles].sort((left, right) => left.timestamp - right.timestamp);

    return {
        firstBarAt: ordered[0]?.timestamp ?? 0,
        lastBarAt: ordered[ordered.length - 1]?.timestamp ?? 0,
    };
}

export async function sealHoldoutVerdict(
    input: SealHoldoutInput,
): Promise<SealedHoldoutVerdict> {
    const status = holdoutStatus(input.candles, input.candidates, input.now);

    // 1. The window. `holdoutStatus` already says the right sentence, so it says
    // it rather than this function inventing a second wording of the same rule.
    if (!status.ready) {
        throw new Error(
            `${status.message} Запечатать окно можно только когда оно наполнено: ` +
                'протокол требует, чтобы вердикт выносился по всей выборке, а не по ' +
                'той части, которая уже набралась.',
        );
    }

    // 3. The closed set, before the readings are looked at — a metric outside it
    //    means the question changed, and that is visible whether or not the rest
    //    of the write would have succeeded.
    const unknown = input.protocol.metrics.filter(
        (metric) => !isKnownMetric(metric),
    );

    if (unknown.length > 0) {
        throw new Error(
            `Протокол спрашивает о метриках вне закрытого набора: ${unknown.join(', ')}. ` +
                'Набор объявлен заранее именно для того, чтобы вопрос нельзя было ' +
                'расширить в момент отчёта.',
        );
    }

    // 2. Completeness, for every rule and every declared metric.
    for (const verdict of input.readings) {
        const missing = input.protocol.metrics.filter(
            (metric) => !(metric in verdict.readings),
        );

        if (missing.length > 0) {
            throw new Error(
                `Вердикт по правилу "${verdict.key}" неполон: нет ${missing.join(', ')}. ` +
                    'Частичная запись — та самая лазейка, ради которой протокол ' +
                    'объявляется целиком: записать можно всё, а прочитать потом — ' +
                    'только то, что записано.',
            );
        }
    }

    if (input.readings.length === 0) {
        throw new Error(
            'Запечатывать нечего: ни одного правила не оценено. Пустой вердикт ' +
                'выглядел бы как «окно прочитано и ничего не показало», что не то же ' +
                'самое, что «окно не читалось».',
        );
    }

    const { firstBarAt, lastBarAt } = windowOf(input.candles);
    const createdAt = input.now ?? Date.now();
    const metrics = [...input.protocol.metrics].sort().join(',');

    try {
        const { rows } = await query<VerdictRow>(
            `INSERT INTO holdout_verdict (
                 id, created_at, protocol_fingerprint, protocol_metrics, protocol_note,
                 readings, candidates, first_bar_at, last_bar_at, bar_count
             ) VALUES (1, $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
             RETURNING id, created_at, protocol_fingerprint, protocol_metrics,
                       protocol_note, readings, candidates, first_bar_at,
                       last_bar_at, bar_count`,
            [
                createdAt,
                protocolFingerprint(input.protocol),
                metrics,
                input.protocol.note,
                JSON.stringify(input.readings),
                JSON.stringify(input.candidates),
                firstBarAt,
                lastBarAt,
                input.candles.length,
            ],
        );

        const row = rows[0];

        if (row === undefined) {
            throw new Error(
                'Запечатывание вернулось без строки, хотя отказ базы не ожидался.',
            );
        }

        return {
            id: 1,
            createdAt: Number(row.created_at),
            protocolFingerprint: row.protocol_fingerprint,
            metrics: row.protocol_metrics.split(','),
            readings: row.readings,
            candidates: row.candidates,
            firstBarAt: Number(row.first_bar_at),
            lastBarAt: Number(row.last_bar_at),
            barCount: row.bar_count,
        };
    } catch (error) {
        // 4. The lock. A primary-key violation here means the window has already
        //    been read, which is the one failure this whole mechanism exists for
        //    and the one a bare "duplicate key value" does not explain.
        //
        //    Read off the **constraint**, not off the message. The first version
        //    did `error.message.includes('holdout_verdict_pkey')` and the project's
        //    own contract test caught it — correctly, and for the reason that
        //    matters: a message is prose, it is translated, and it changes between
        //    server versions. `constraint` is part of the schema this function
        //    already depends on, so asking for it by name is asking the database a
        //    question rather than reading its diary.
        if (violatesHoldoutSingleton(error)) {
            throw new Error(
                'Окно уже было прочитано: строка вердикта существует, а протокол ' +
                    'разрешает ровно одну. Второе чтение — это уже не проверка ' +
                    'предсказания, а выбор вопроса по результату первого. ' +
                    'Строка в таблице и есть тот ответ, который был выбран.',
            );
        }

        throw error;
    }
}

/** The sealed verdict, or null while the window has never been read. */
export async function readSealedHoldoutVerdict(): Promise<SealedHoldoutVerdict | null> {
    const { rows } = await query<VerdictRow>(
        `SELECT id, created_at, protocol_fingerprint, protocol_metrics,
                protocol_note, readings, candidates, first_bar_at, last_bar_at,
                bar_count
           FROM holdout_verdict
          WHERE id = 1`,
    );

    const row = rows[0];

    if (row === undefined) {
        return null;
    }

    return {
        id: 1,
        createdAt: Number(row.created_at),
        protocolFingerprint: row.protocol_fingerprint,
        metrics: row.protocol_metrics.split(','),
        readings: row.readings,
        candidates: row.candidates,
        firstBarAt: Number(row.first_bar_at),
        lastBarAt: Number(row.last_bar_at),
        barCount: row.bar_count,
    };
}

export { HOLDOUT_MINIMUM_BARS };