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
