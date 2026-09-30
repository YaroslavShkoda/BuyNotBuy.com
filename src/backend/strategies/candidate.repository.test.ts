import { beforeEach, describe, expect, it } from 'vitest';

import {
    CANDIDATE_STAGES,
    canTransition,
    createStrategyRuleRepository,
} from './candidate.repository.js';

import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';

import type { Promotion } from './candidate.repository.js';

const NOW = 1_760_000_000_000;

const promotion = (over: Partial<Promotion> = {}): Promotion => ({
    ruleId: 'donchian-20',
    to: 'candidate',
    parameters: { channelPeriod: 20 },
    evidence: 'Плато 14—24 по длине канала.',
    at: NOW,
    ...over,
});

describe('a promotion remembers which configuration it was under', () => {
    const rules = createStrategyRuleRepository();

    /** A real version row, because the column has a foreign key and should. */
    const aVersion = async (): Promise<number> => {
        const pool = getTestPool();
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO strategy_version (created_at, name, description, config, config_hash)
             VALUES ($1, 'bridge-test', '', '{}'::jsonb, $2)
             RETURNING id`,
            [NOW, `bridge-${Math.random()}`],
        );

        return Number(rows[0]?.id);
    };

    beforeEach(async () => {
        const pool = getTestPool();

        await pool.query('TRUNCATE signal_strategy_version');
    });

    it('records the strategy version so the row can be joined to a measurement', async () => {
        // **The join that did not exist.** Measurements are filed under
        // `strategy_version`; the ladder was filed under `rule_id`; and nothing
        // anywhere recorded that a promotion happened under one particular
        // configuration. Without this, the evidence gate could not be wired
        // even with complete data — there was nothing to query.
        const version = await aVersion();
        const record = await rules.promote(promotion({ strategyVersionId: version }));

        expect(record.strategyVersionId).toBe(version);
    });

    it('survives the round trip, which is the only thing that proves it is stored', async () => {
        const version = await aVersion();

        await rules.promote(promotion({ strategyVersionId: version }));

        const [current] = await rules.history('donchian-20');

        expect(current?.strategyVersionId).toBe(version);
    });

    it('refuses a version that does not exist', async () => {
        // SQLSTATE 23503. A promotion that named a configuration nobody has
        // would produce a row pointing at nothing, and the evidence gate would
        // read it as "this rule was measured under version 9999" — a number
        // with no row behind it is worse than a null, because a null is
        // visibly absent.
        await expect(rules.promote(promotion({ strategyVersionId: 999_999 }))).rejects.toThrow();
    });

    it('says it does not know rather than naming a plausible version', async () => {
        // Null here is a fact the evidence gate must refuse on, not a gap to
        // fill. The rule's parameters and the indicator configuration are
        // different spaces, so there is nothing to compute this from — a rule
        // with `{channelPeriod: 20}` has no representation in
        // `strategy_version.config` at all.
        const record = await rules.promote(promotion());

        expect(record.strategyVersionId).toBeNull();
    });
});

describe('a rule cannot reach production without passing through', () => {
    const rules = createStrategyRuleRepository();

    beforeEach(async () => {
        await truncateSignalTables();
    });

    it('is refused a promotion that says nothing about why', () => {
        // One careless call away, and the reason the table exists.
        return expect(
            rules.promote(promotion({ evidence: '   ' })),
        ).rejects.toThrow('saying what the decision rests on');
    });

    it('cannot be created directly as anything but a candidate', async () => {
        // The transition check used to run only against a rule that already
        // existed, so the very first promotion — the one that decides
        // everything after it — was the one promotion that skipped it.
        return expect(
            rules.promote(promotion({ to: 'production' })),
        ).rejects.toThrow('starts as a candidate');
    });

    it('cannot skip the shadow period on the way to production', async () => {
        await rules.promote(promotion());

        return expect(
            rules.promote(promotion({ to: 'production' })),
        ).rejects.toThrow('Stages move forward only');
    });

    it('walks the whole chain and records every step', async () => {
        await rules.promote(promotion());

        // Strictly increasing. An earlier version derived the timestamp from
        // the stage name's length, which put 'shadow' before 'walk-forward'
        // and made the history come back in the wrong order — the kind of
        // mistake that looks like a data problem and is a test problem.
        const stages = [
            'backtest',
            'walk-forward',
            'shadow',
            'approval',
            'production',
        ] as const;

        for (const [index, stage] of stages.entries()) {
            await rules.promote(promotion({ to: stage, at: NOW + (index + 1) * 1000 }));
        }

        const history = await rules.history('donchian-20');

        // Six rows: the initial registration plus five promotions. An audit
        // that keeps only the current state is a state, not a record.
        expect(history.map((row) => row.stage)).toEqual([
            'candidate',
            'backtest',
            'walk-forward',
            'shadow',
            'approval',
            'production',
        ]);
        expect((await rules.current('donchian-20'))!.stage).toBe('production');
    });

    it('retires a rule with a date, and does not let it come back', async () => {
        await rules.promote(promotion());
        await rules.promote(promotion({ to: 'retired', at: NOW + 5000 }));

        const current = await rules.current('donchian-20');
        expect(current!.retiredAt).toBe(NOW + 5000);
        // The stage as well as the date. Stamping only the date left the rule
        // sitting in 'candidate' and therefore still promotable to backtest,
        // which is a retirement that can be undone by the next call.
        expect(current!.stage).toBe('retired');

        return expect(
            rules.promote(promotion({ to: 'backtest', at: NOW + 6000 })),
        ).rejects.toThrow('Stages move forward only');
    });

    it('will not let a retired rule be walked back to production', async () => {
        await rules.promote(promotion());
        await rules.promote(promotion({ to: 'retired', at: NOW + 5000 }));

        return expect(
            rules.promote(promotion({ to: 'production', at: NOW + 7000 })),
        ).rejects.toThrow();
    });

    it('keeps the evidence with the row, since the table has nowhere else to put it', async () => {
        await rules.promote(
            promotion({ evidence: 'Инверсия фильтра измерена: +33.58%.' }),
        );

        const current = await rules.current('donchian-20');
        expect(current!.evidence).toContain('+33.58%');
    });

    it('keeps two rules apart', async () => {
        await rules.promote(promotion());
        await rules.promote(promotion({ ruleId: 'donchian-calm-gated' }));

        expect(await rules.history('donchian-calm-gated')).toHaveLength(1);
        expect(await rules.history('donchian-20')).toHaveLength(1);
    });
});

describe('the chain itself', () => {
    it('moves forward and skips nothing', () => {
        expect(canTransition('candidate', 'backtest')).toBe(true);
        expect(canTransition('candidate', 'shadow')).toBe(false);
        expect(canTransition('shadow', 'approval')).toBe(true);
        expect(canTransition('approval', 'production')).toBe(true);
    });

    it('ends at retirement, in every direction', () => {
        for (const stage of ['candidate', 'backtest', 'walk-forward', 'shadow', 'approval', 'production'] as const) {
            expect(canTransition(stage, 'retired')).toBe(true);
        }

        expect(canTransition('retired', 'candidate')).toBe(false);
        expect(canTransition('production', 'shadow')).toBe(false);
    });
});

describe('the table it writes to', () => {
    it('is the one migration twelve created and nothing read until now', async () => {
        await truncateSignalTables();

        const { rows } = await getTestPool().query<{ count: string }>(
            'SELECT COUNT(*) AS count FROM signal_strategy_version',
        );

        expect(Number(rows[0]!.count)).toBe(0);
    });

    it('will not store a stage the ladder does not have', async () => {
        // The column was NOT NULL text with no CHECK, so it was the one place
        // in the system that records how far a rule got, and it would have
        // taken any word at all. `canTransition` refuses to skip a stage; this
        // refuses a stage that does not exist. They are different questions and
        // only the second one is the database's to answer.
        await truncateSignalTables();

        const insert = (stage: string) =>
            getTestPool().query(
                `INSERT INTO signal_strategy_version
                     (rule_id, stage, parameters, promoted_at, created_at)
                 VALUES ('donchian-20', $1, '{}'::jsonb, $2, $2)`,
                [stage, NOW],
            );

        // Negative control first: the word the ladder has, which must work. If
        // this failed, everything below would pass for the wrong reason.
        await expect(insert('shadow')).resolves.toBeDefined();
        await expect(insert('banana')).rejects.toThrow();
        await expect(insert('walk_forwarded')).rejects.toThrow();
        await expect(insert('rejected')).rejects.toThrow();
        await expect(insert('approved')).rejects.toThrow();
    });

    it('stores exactly the stages the code knows and no others', async () => {
        // The CHECK and CANDIDATE_STAGES are two copies of one list, and two
        // copies drift — rename a stage in one and the repository would refuse
        // to write what the database accepts, or the other way round. This reads
        // the list the database actually enforces and compares it to the list
        // the code transitions between, in both directions and as a set.
        await truncateSignalTables();

        const { rows } = await getTestPool().query<{ definition: string }>(
            `SELECT pg_get_constraintdef(oid) AS definition
               FROM pg_constraint
              WHERE conrelid = 'signal_strategy_version'::regclass
                AND conname = 'signal_strategy_version_stage_check'`,
        );

        const definition = rows[0]?.definition;
        expect(definition).toBeDefined();

        const inDatabase = [...(definition ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);

        expect([...inDatabase].sort()).toEqual([...CANDIDATE_STAGES].sort());
        expect(inDatabase).toHaveLength(CANDIDATE_STAGES.length);
    });
});
