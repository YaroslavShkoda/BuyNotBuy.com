import { beforeEach, describe, expect, it } from 'vitest';

import { canTransition, createStrategyRuleRepository } from './candidate.repository.js';

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
});
