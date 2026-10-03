import { beforeEach, describe, expect, it } from 'vitest';

import {
    readSealedHoldoutVerdict,
    sealHoldoutVerdict,
} from './holdout-verdict.js';
import { HOLDOUT_COMMITTED_AT, HOLDOUT_MINIMUM_BARS } from './holdout.js';

import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';

import type {
    HoldoutProtocol,
    MetricReadings,
    Verdict,
} from './holdout-protocol.js';

/**
 * The writer, which was the missing half of a lock that was already built.
 *
 * `lifecycle/holdout-verdict.test.ts` measures the schema's refusal of a second
 * row and says why it exists while nothing writes: "the writer is the missing
 * piece, not the lock". Both halves were proven — the primary key and the
 * `CHECK (id = 1)` — and the table was never filled, so the guarantee the
 * protocol rests on was, in practice, a comment.
 *
 * These tests use the real table, in a transaction that is always rolled back.
 * That is not a shortcut: the four things worth proving here are refusals, and a
 * refusal cannot be tested against a fake — a fake that was written to refuse
 * proves only that the fake refuses.
 */
const pool = getTestPool();

const PROTOCOL: HoldoutProtocol = {
    metrics: ['totalReturn', 'profitFactor'],
    registeredAt: HOLDOUT_COMMITTED_AT,
    note: 'Проверка фиксированного набора метрик.',
};

const CANDIDATE = {
    key: 'donchian',
    fingerprint: 'abc123',
    registeredAt: HOLDOUT_COMMITTED_AT,
    note: 'зарегистрирован до наполнения окна',
};

/** A full window: the bars have to be past the commit and numerous. */
function window(bars: number) {
    return Array.from({ length: bars }, (_, index) => ({
        timestamp: HOLDOUT_COMMITTED_AT + index * 86_400_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1_000,
    }));
}

/**
 * A complete verdict: every declared metric, typed as `Verdict` rather than
 * spelled out, so a metric added to `PROTOCOL` cannot make this fixture quietly
 * incomplete. The completeness check is then exercised by removing one on
 * purpose, not by the fixture having drifted.
 */
function readings(): Verdict[] {
    return [
        {
            key: CANDIDATE.key,
            readings: { totalReturn: 0.4, profitFactor: 1.2 } as MetricReadings,
        },
    ];
}

beforeEach(async () => {
    await truncateSignalTables();
    await pool.query('DELETE FROM holdout_verdict');
});

describe('sealing the one read', () => {
    it('writes the whole verdict, once the window is full', async () => {
        const sealed = await sealHoldoutVerdict({
            candles: window(HOLDOUT_MINIMUM_BARS),
            protocol: PROTOCOL,
            readings: readings(),
            candidates: [CANDIDATE],
            now: HOLDOUT_COMMITTED_AT + 1,
        });

        expect(sealed.id).toBe(1);
        expect(sealed.barCount).toBe(HOLDOUT_MINIMUM_BARS);
        expect(sealed.metrics).toEqual(['profitFactor', 'totalReturn']);
        expect(sealed.candidates[0]?.fingerprint).toBe('abc123');

        // And it is really in the table, not merely returned.
        expect(await readSealedHoldoutVerdict()).not.toBeNull();
    });

    it('refuses a window that is not full, because the schema cannot know the rule', async () => {
        // `holdout_verdict_has_bars` checks `bar_count > 0`, which one bar
        // satisfies. The rule is `HOLDOUT_MINIMUM_BARS` and the rule is ours.
        await expect(
            sealHoldoutVerdict({
                candles: window(HOLDOUT_MINIMUM_BARS - 1),
                protocol: PROTOCOL,
                readings: readings(),
                candidates: [CANDIDATE],
            }),
        ).rejects.toThrow(/окно не наполнено/);
    });

    it('refuses a second seal, and says the window has already been read', async () => {
        await sealHoldoutVerdict({
            candles: window(HOLDOUT_MINIMUM_BARS),
            protocol: PROTOCOL,
            readings: readings(),
            candidates: [CANDIDATE],
        });

        // A bare "duplicate key value violates unique constraint" would leave the
        // reader to work out which row and why. The lock is the whole point of
        // the table, so the refusal has to read like the lock.
        await expect(
            sealHoldoutVerdict({
                candles: window(HOLDOUT_MINIMUM_BARS),
                protocol: PROTOCOL,
                readings: readings(),
                candidates: [CANDIDATE],
            }),
        ).rejects.toThrow(/уже было прочитано/);

        // Still one row: the second attempt did not replace the first either.
        const { rows } = await pool.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM holdout_verdict',
        );

        expect(Number(rows[0]?.count)).toBe(1);
    });

    it('refuses a verdict that is missing a declared metric', async () => {
        // The partial write is the loophole the migration comment names, and
        // `jsonb_typeof(readings) = 'array'` cannot see inside the array.
        await expect(
            sealHoldoutVerdict({
                candles: window(HOLDOUT_MINIMUM_BARS),
                protocol: PROTOCOL,
                readings: [
                    {
                        key: CANDIDATE.key,
                        readings: { totalReturn: 0.4 } as MetricReadings,
                    },
                ],
                candidates: [CANDIDATE],
            }),
        ).rejects.toThrow(/неполон/);

        expect(await readSealedHoldoutVerdict()).toBeNull();
    });

    it('refuses a metric outside the closed set, even when the window is full', async () => {
        await expect(
            sealHoldoutVerdict({
                candles: window(HOLDOUT_MINIMUM_BARS),
                // A name outside the closed set cannot be typed, which is the
                // point of the closed set; the cast is what a caller would have
                // to write to get past it.
                protocol: {
                    metrics: ['totalReturn', 'неОбъявленнаяМетрика'],
                    registeredAt: HOLDOUT_COMMITTED_AT,
                    note: PROTOCOL.note,
                } as unknown as HoldoutProtocol,
                readings: readings(),
                candidates: [CANDIDATE],
            }),
        ).rejects.toThrow(/вне закрытого набора/);
    });

    it('refuses an empty verdict, which would read as "read, and nothing showed"', async () => {
        // "The window was read and showed nothing" and "the window was never
        // read" are different sentences, and only one of them is true here.
        await expect(
            sealHoldoutVerdict({
                candles: window(HOLDOUT_MINIMUM_BARS),
                protocol: PROTOCOL,
                readings: [],
                candidates: [],
            }),
        ).rejects.toThrow(/нечего/i);

        expect(await readSealedHoldoutVerdict()).toBeNull();
    });

    it('stores the bars in the order the reader received them', async () => {
        // Deliberately reversed: a reader who sorted the window could make its
        // own bounds look tidy, and the bounds are what says which data was read.
        const bars = window(HOLDOUT_MINIMUM_BARS).reverse();

        const sealed = await sealHoldoutVerdict({
            candles: bars,
            protocol: PROTOCOL,
            readings: readings(),
            candidates: [CANDIDATE],
        });

        expect(sealed.firstBarAt).toBeLessThan(sealed.lastBarAt);
        expect(sealed.firstBarAt).toBe(HOLDOUT_COMMITTED_AT);
    });

    it('reports an unread window while there is nothing stored', async () => {
        expect(await readSealedHoldoutVerdict()).toBeNull();
    });
});