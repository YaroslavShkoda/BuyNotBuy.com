import { beforeEach, describe, expect, it } from 'vitest';

import { createStrategyRuleRepository } from '../strategies/candidate.repository.js';
import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';

import type { GateCheck, Promotion, PromotionGate } from '../strategies/candidate.repository.js';

const NOW = 1_760_000_000_000;

/** Records what it was asked, and says no or yes as told. */
const gate = (verdict: { ready: boolean; reason: string; outstanding: readonly string[] }) => {
    const asked: GateCheck[] = [];

    const impl: PromotionGate = {
        async check(check) {
            asked.push(check);

            if (!verdict.ready) {
                throw new Error(`${check.ruleId} is not ready: ${verdict.reason}`);
            }
        },
    };

    return { impl, asked };
};

describe('a rule has to earn approval', () => {
    const pool = getTestPool();

    // Real rows: the foreign key refuses a version that does not exist, which
    // is correct and which these tests are not about.
    let version = 0;
    let other = 0;

    const promotion = (over: Partial<Promotion> = {}): Promotion => ({
        ruleId: 'donchian-20',
        to: 'approval',
        parameters: { channelPeriod: 20 },
        evidence: 'Плато 14—24 по длине канала.',
        strategyVersionId: version,
        at: NOW,
        ...over,
    });

    const aVersion = async (name: string): Promise<number> => {
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO strategy_version (created_at, name, description, config, config_hash)
             VALUES ($1, $2, '', '{}'::jsonb, $3) RETURNING id`,
            [NOW, name, `${name}-${Math.random()}`],
        );

        return Number(rows[0]?.id);
    };

    beforeEach(async () => {
        await truncateSignalTables();
        await pool.query('TRUNCATE signal_strategy_version CASCADE');
        version = await aVersion('shadowed');
        other = await aVersion('incumbent');
    });

    /** A rule walked up to shadow, so approval is a legal next step. */
    const inShadow = async (): Promise<void> => {
        const rules = createStrategyRuleRepository();

        for (const stage of ['candidate', 'backtest', 'walk-forward', 'shadow'] as const) {
            await rules.promote(promotion({ to: stage }));
        }
    };

    it('refuses when the evidence does not hold up', async () => {
        await inShadow();

        const closed = gate({ ready: false, reason: 'мало сигналов', outstanding: ['сигналов 3'] });
        const rules = createStrategyRuleRepository(closed.impl);

        await expect(rules.promote(promotion())).rejects.toThrow(/не готов|not ready/);

        // Nothing was written: a refused promotion must leave no trace that
        // could later be mistaken for one that happened. `history` is oldest
        // first, so the last row is where the rule actually stands.
        const rows = await rules.history('donchian-20');

        expect(rows.at(-1)?.stage).toBe('shadow');
    });

    it('is asked about the configuration the promotion claims, not the active one', async () => {
        await inShadow();

        const closed = gate({ ready: false, reason: 'нет', outstanding: [] });

        await createStrategyRuleRepository(closed.impl)
            .promote(promotion({ strategyVersionId: other }))
            .catch(() => undefined);

        // The fallback case: when the active configuration and the shadowed one
        // differ, grading the candidate on the incumbent's numbers measures the
        // wrong rule entirely.
        expect(closed.asked[0]?.strategyVersionId).toBe(other);
    });

    it('is asked about the stage being entered', async () => {
        await inShadow();

        const closed = gate({ ready: false, reason: 'нет', outstanding: [] });

        await createStrategyRuleRepository(closed.impl)
            .promote(promotion({ to: 'production', strategyVersionId: 4 }))
            .catch(() => undefined);

        expect(closed.asked[0]?.to).toBe('production');
    });

    it('asks nothing at all when no gate was supplied', async () => {
        // **This is the hole the gate exists to close.** Without one the only
        // checks left are that the evidence string is not empty and that the
        // stage names are in order — so a rule that reached shadow reaches
        // approval on the strength of a sentence, having produced no signal at
        // all.
        await inShadow();

        const record = await createStrategyRuleRepository().promote(promotion());

        expect(record.stage).toBe('approval');
    });

    it('lets the promotion through when the evidence holds', async () => {
        await inShadow();

        const open = gate({ ready: true, reason: 'достаточно', outstanding: [] });
        const record = await createStrategyRuleRepository(open.impl).promote(promotion());

        expect(record.stage).toBe('approval');
        expect(open.asked).toHaveLength(1);
    });
});
