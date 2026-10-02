import { describe, expect, it } from 'vitest';

import { getTestPool } from '../test-support/test-database.js';

/**
 * The held-out window's one read, enforced by the schema rather than by discipline.
 *
 * `docs/roadmap-v2-status.md` and `holdout.ts` both say the same thing in
 * different words: reading a number leaves no trace, so the guarantee cannot be
 * attached to the data, only to the question — a closed metric set, a
 * fingerprinted protocol, a verdict stored whole. And migration 14 says the
 * `CHECK (id = 1)` is "the most a piece of schema can do about a rule about
 * reading".
 *
 * **That claim was never tested, and it turned out to be two constraints doing
 * two different halves of the work rather than one doing all of it.** Measured,
 * in a transaction and rolled back, because writing a verdict to find out
 * whether a second one is refused is the one way to make the answer permanently
 * true:
 *
 * - `holdout_verdict_pkey` refuses a *duplicate* `id` — "not two rows with the
 *   same id".
 * - `holdout_verdict_singleton` refuses `id = 2` and `id = 7` — "no row at all
 *   except id 1", which the primary key alone would happily have accepted,
 *   indefinitely, since every new id is a new primary key.
 *
 * So the lock holds, and the comment attributing it to the CHECK alone was
 * half the story. Both are asserted below, separately, because a test that only
 * tried a duplicate id would pass on the primary key alone and would not notice
 * the `CHECK` being dropped — which is the edit someone makes when they read
 * "id is the primary key, this CHECK is redundant".
 *
 * **Why this is worth a test at all, when nothing writes the table.** Because
 * the writer is the missing piece, not the lock: no production module and no
 * other test reads or writes `holdout_verdict`. A lock nobody opens is still a
 * lock, and the day the writer arrives it should meet a proven constraint rather
 * than an assumed one. Proven by bad input, the same rule as everywhere else in
 * this work.
 *
 * Each case rolls back to its own savepoint: a rejected statement aborts a
 * PostgreSQL transaction, so without them every case after the first would report
 * the abort instead of the constraint it was written to measure. That is not
 * hypothetical — the first run of this probe said the primary key was the only
 * thing refusing rows, because the transaction was already dead.
 *
 * Isolation comes from the per-test schema the setup file creates and drops, so
 * an unqualified INSERT lands there and the live database is never touched.
 */

const INSERT = `
    INSERT INTO holdout_verdict (
        id, created_at, protocol_fingerprint, protocol_metrics, protocol_note,
        readings, candidates, first_bar_at, last_bar_at, bar_count
    ) VALUES ($1, 1, 'probe', 'a,b', 'probe', '[]'::jsonb, '[]'::jsonb, 1, 2, 1)`;

const pool = getTestPool();

/**
 * Inserts a sequence of ids in one transaction and reports the first refusal.
 *
 * **The sequence has to be inside one transaction**, and the first version of
 * this rolled back after every single insert — so "a second row with the same id"
 * was inserted into an empty table and accepted, and the test whose name said
 * the primary key refuses duplicates passed without testing anything. The probe
 * that found the constraint names in the first place had made exactly the same
 * mistake one level lower down, and this is the second time this shape of error
 * has cost more than the change it was written for.
 *
 * A savepoint is taken *between* the inserts, because a rejected statement aborts
 * a PostgreSQL transaction and everything after it would report the abort rather
 * than the constraint.
 */
async function insertSequence(ids: readonly number[]): Promise<{
    readonly accepted: readonly number[];
    readonly refusedAt: number | null;
    readonly reason: string | null;
}> {
    const client = await pool.connect();
    const accepted: number[] = [];

    try {
        await client.query('BEGIN');

        let refusedAt: number | null = null;
        let reason: string | null = null;

        for (const [index, id] of ids.entries()) {
            if (index > 0) await client.query(`SAVEPOINT step_${index}`);

            try {
                await client.query(INSERT, [id]);
                accepted.push(id);
            } catch (error) {
                refusedAt = id;
                reason = error instanceof Error ? error.message : String(error);
                break;
            }
        }

        await client.query('ROLLBACK');

        return { accepted, refusedAt, reason };
    } finally {
        client.release();
    }
}

describe('the verdict table will hold exactly one row, and the schema says so', () => {
    it('accepts a first verdict', async () => {
        const result = await insertSequence([1]);

        expect(result.accepted).toEqual([1]);
        expect(result.refusedAt).toBeNull();
    }, 30_000);

    it('refuses a second row with the same id, by the primary key', async () => {
        const result = await insertSequence([1, 1]);

        expect(result.accepted).toEqual([1]);
        expect(result.refusedAt).toBe(1);
        expect(result.reason).toContain('holdout_verdict_pkey');
    }, 30_000);

    it('refuses any other id, by the CHECK — which the primary key would allow', async () => {
        // The half that is not obvious. `id` is the primary key, so id 2 and id 7
        // are each a perfectly valid new key: without the CHECK this table would
        // take one verdict per id and the one-read rule would be a suggestion
        // with a comment attached.
        for (const id of [2, 7]) {
            const result = await insertSequence([1, id]);

            expect(result.accepted, `id=${id} был принят`).toEqual([1]);
            expect(result.refusedAt).toBe(id);
            expect(result.reason).toContain('holdout_verdict_singleton');
        }
    }, 30_000);

    it('and this is a per-database singleton, not a per-market one', async () => {
        // The reason B6 cannot be closed by editing a constraint, and the reason
        // this test exists before the writer does.
        //
        // `id` is a bare integer with no market on it, so the guarantee is "one
        // verdict in this database, ever". The moment a second market runs, that
        // is the wrong guarantee twice over: the second market can never be
        // judged, and the first market's verdict becomes the only thing the
        // table can say about either of them.
        //
        // So the key has to carry the market, and it has to do so **before** the
        // second market exists — not after, because a verdict already written
        // under `id = 1` would then be a row whose key is wrong, and this table
        // is the one place in the project where rewriting a stored measurement
        // is not an option.
        //
        // Blocking it is a writer that does not exist yet: no production module
        // and no other test reads or writes this table. Changing the lock before
        // there is a key to lock is the premature table the project's own notes
        // warn about, and it would also leave a constraint nobody has ever
        // exercised. The honest order is: the writer, then the market in the key,
        // then a per-market lock proven the same way this one is.
        const columns = await pool.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'holdout_verdict'`,
        );
        const names = columns.rows.map((row) => row.column_name);

        expect(names).toContain('id');
        expect(names).not.toContain('symbol');
        expect(names).not.toContain('market');
        expect(names).not.toContain('instrument');
    }, 30_000);
});
