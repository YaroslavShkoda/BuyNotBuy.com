import { describe, expect, it, beforeEach } from 'vitest';

import { createDecisionLogRepository } from './decision-log.repository.js';

import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';

import type { DecisionEntry } from './decision-log.repository.js';

const NOW = 1_760_000_000_000;

const entry = (over: Partial<DecisionEntry> = {}): DecisionEntry => ({
    symbol: 'BTCUSDT',
    strategyVersionId: null,
    at: NOW,
    primary: {
        rule: 'consensus-primary',
        direction: 'NEUTRAL',
        confidence: 0,
    },
    fallback: {
        rule: 'donchian-trend-gated',
        direction: 'LONG',
        confidence: 55,
    },
    publishedRule: 'consensus-primary',
    publishedDirection: 'NEUTRAL',
    suppressed: true,
    ...over,
});

describe('what the strategies said is kept', () => {
    const repository = createDecisionLogRepository();

    beforeEach(async () => {
        await truncateSignalTables();
    });

    it('stores both answers, not only the one that was published', () => {
        // The disagreements are the only rows worth having, and they are
        // exactly the ones a published answer cannot reconstruct.
        return repository
            .record(entry())
            .then(() => getTestPool().query<{
                primary_direction: string;
                fallback_direction: string;
                published_direction: string;
                suppressed: boolean;
            }>(`SELECT primary_direction, fallback_direction,
                       published_direction, suppressed
                  FROM strategy_decision_log`))
            .then(({ rows }) => {
                expect(rows).toHaveLength(1);
                expect(rows[0]!.primary_direction).toBe('NEUTRAL');
                expect(rows[0]!.fallback_direction).toBe('LONG');
                expect(rows[0]!.published_direction).toBe('NEUTRAL');
                expect(rows[0]!.suppressed).toBe(true);
            });
    });

    it('refuses a row claiming a suppression nobody could have made', () => {
        // A suppression without a fallback answer is a row that says something
        // happened when nothing did.
        return expect(
            getTestPool().query(
                `INSERT INTO strategy_decision_log
                     (created_at, symbol, primary_rule, primary_direction,
                      primary_confidence, published_rule, published_direction,
                      suppressed)
                 VALUES ($1, 'BTCUSDT', 'consensus-primary', 'NEUTRAL', 0,
                         'consensus-primary', 'NEUTRAL', true)`,
                [NOW],
            ),
        ).rejects.toThrow();
    });

    it('refuses a direction that is not one of the three', () => {
        return expect(
            getTestPool().query(
                `INSERT INTO strategy_decision_log
                     (created_at, symbol, primary_rule, primary_direction,
                      primary_confidence, published_rule, published_direction,
                      suppressed)
                 VALUES ($1, 'BTCUSDT', 'consensus-primary', 'MAYBE', 0,
                         'consensus-primary', 'NEUTRAL', false)`,
                [NOW],
            ),
        ).rejects.toThrow();
    });
});

describe('the shadow period, read back', () => {
    const repository = createDecisionLogRepository();

    beforeEach(async () => {
        await truncateSignalTables();
    });

    it('counts what was held back and what was heard', async () => {
        for (const over of [
            { at: NOW, suppressed: true, fallback: { rule: 'donchian-20' as const, direction: 'LONG' as const, confidence: 60 } },
            { at: NOW + 1, suppressed: true, fallback: { rule: 'donchian-20' as const, direction: 'LONG' as const, confidence: 60 } },
            {
                at: NOW + 2,
                suppressed: false,
                fallback: { rule: 'donchian-20' as const, direction: 'NEUTRAL' as const, confidence: 0 },
            },
        ]) {
            await repository.record(entry(over));
        }

        const report = await repository.shadowReport(NOW);

        expect(report.cycles).toBe(3);
        expect(report.suppressed).toBe(2);
        expect(report.byDirection.LONG).toBe(2);
        expect(report.byDirection.NEUTRAL).toBe(1);
        expect(report.breakdown).toHaveLength(1);
        expect(report.breakdown[0]!.rule).toBe('donchian-20');
    });

    it('reports agreement only among the cycles where the fallback was heard', async () => {
        // A fallback that disagrees always has something to teach and one that
        // always agrees has nothing; dividing by the wrong denominator would
        // make the quiet case look busy.
        for (const over of [
            { at: NOW, suppressed: true, fallback: { rule: 'donchian-20' as const, direction: 'LONG' as const, confidence: 60 } },
            {
                at: NOW + 1,
                suppressed: false,
                primary: { rule: 'consensus-primary' as const, direction: 'SHORT' as const, confidence: 40 },
                fallback: { rule: 'donchian-20' as const, direction: 'SHORT' as const, confidence: 60 },
                publishedRule: 'donchian-20' as const,
                publishedDirection: 'SHORT' as const,
            },
        ]) {
            await repository.record(entry(over));
        }

        const report = await repository.shadowReport(NOW);

        // One suppressed, one heard and in agreement.
        expect(report.cycles).toBe(2);
        expect(report.suppressed).toBe(1);
        expect(report.agreement).toBe(1);
    });

    it('ignores what happened before the window it was asked about', async () => {
        await repository.record(entry({ at: NOW }));
        await repository.record(entry({ at: NOW + 10_000 }));

        expect((await repository.shadowReport(NOW)).cycles).toBe(2);
        expect((await repository.shadowReport(NOW + 5_000)).cycles).toBe(1);
        expect((await repository.shadowReport(NOW + 20_000)).cycles).toBe(0);
    });

    it('reports zero rather than dividing by nothing', async () => {
        const report = await repository.shadowReport(NOW);

        expect(report.cycles).toBe(0);
        expect(report.agreement).toBe(0);
    });
});

describe('a shadow report can be asked about one asset', () => {
    /**
     * The table has carried `symbol` since it was created and `record()` writes
     * it on every row. The reader had no way to use it: `shadowReport` counted
     * agreement across every asset the system trades. That is the same shape as
     * `evidenceFor`, the defect `strategy/cross-asset-isolation.test.ts`
     * documents, and here it is not merely present — it is the number a rule
     * would be judged by before publishing.
     *
     * The blend is still reachable by omitting the symbol, and that is the
     * decision rather than an oversight: a mandatory filter would delete the
     * system-wide view instead of labelling it, and a view that cannot be asked
     * for gets asked for through a second hand-written query within a month.
     * The blend is now something a caller chooses.
     */
    const repository = createDecisionLogRepository();

    /** One asset where the fallback is heard and always agrees. */
    const agreeing = (symbol: string): DecisionEntry =>
        entry({
            symbol,
            suppressed: false,
            primary: { rule: 'consensus-primary', direction: 'LONG' as const, confidence: 40 },
            fallback: { rule: 'donchian-20' as const, direction: 'LONG' as const, confidence: 60 },
            publishedRule: 'donchian-20',
            publishedDirection: 'LONG' as const,
        });

    /** One asset where it is heard and never agrees. */
    const disagreeing = (symbol: string): DecisionEntry =>
        entry({
            symbol,
            suppressed: false,
            primary: { rule: 'consensus-primary', direction: 'NEUTRAL' as const, confidence: 40 },
            fallback: { rule: 'donchian-20' as const, direction: 'SHORT' as const, confidence: 60 },
            publishedRule: 'consensus-primary',
            publishedDirection: 'NEUTRAL' as const,
        });

    beforeEach(async () => {
        await truncateSignalTables();

        for (const at of [NOW, NOW + 1]) {
            await repository.record({ ...agreeing('BTCUSDT'), at });
            await repository.record({ ...disagreeing('ETHUSDT'), at });
        }
    });

    it('counts only the cycles of the asset it was asked about', async () => {
        // The property. Two assets, two cycles each, and the answer for one is
        // 2 rather than 4. Before the filter this was 4 for both, and a
        // blended agreement of 0.5 — a figure no asset produced, since one was
        // at 1.0 and the other at 0.0.
        const btc = await repository.shadowReport(NOW, 'BTCUSDT');
        const eth = await repository.shadowReport(NOW, 'ETHUSDT');

        expect(btc.cycles).toBe(2);
        expect(eth.cycles).toBe(2);
        expect(btc.agreement).toBe(1);
        expect(eth.agreement).toBe(0);
    });

    it('narrows the direction tally along with the breakdown', async () => {
        // Left unscoped while the breakdown was scoped, the report would answer
        // "for this asset" with a breakdown that agreed and a tally that did
        // not, and the two are read side by side.
        const btc = await repository.shadowReport(NOW, 'BTCUSDT');

        // BTC's fallback said LONG twice; ETH's said SHORT twice. SHORT is
        // reported as zero rather than absent, which is the better of the two:
        // "no SHORT cycles happened" and "SHORT was not counted" are different
        // answers, and only the first of them is true.
        expect(btc.byDirection.LONG).toBe(2);
        expect(btc.byDirection.SHORT).toBe(0);
    });

    it('reports nothing for an asset that never traded', async () => {
        // Zero cycles must read as zero rather than as the blend, which is the
        // failure a default would reintroduce.
        const report = await repository.shadowReport(NOW, 'SOLUSDT');

        expect(report.cycles).toBe(0);
        expect(report.agreement).toBe(0);
    });

    it('still blends every asset when no asset is named', async () => {
        // The blend stays reachable, and it is stated rather than inherited.
        const report = await repository.shadowReport(NOW);

        expect(report.cycles).toBe(4);
        expect(report.byDirection.LONG).toBe(2);
        expect(report.byDirection.SHORT).toBe(2);
    });
});
