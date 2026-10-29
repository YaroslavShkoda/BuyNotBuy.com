import { describe, expect, it } from 'vitest';
import { createDecisionLogRepository, type DecisionEntry } from '../strategies/decision-log.repository.js';
import { getTestPool } from '../test-support/test-database.js';
import { migration026_decision_confidence_precision } from './migrations/026_decision_confidence_precision.js';

const decision = (at: number, primary: number, fallback: number | null): DecisionEntry => ({
    symbol: 'BTCUSDT', interval: '1h', strategyVersionId: null, at,
    primary: { rule: 'consensus-primary', direction: 'LONG', confidence: primary },
    fallback: fallback === null ? null : { rule: 'donchian-trend-gated', direction: 'LONG', confidence: fallback },
    publishedRule: 'consensus-primary', publishedDirection: 'LONG', suppressed: false,
});

describe('decision confidence schema precision', () => {
    const repository = createDecisionLogRepository();

    it('upgrades populated INTEGER columns without changing legacy values, row identity or nullability and can repeat', async () => {
        await repository.record(decision(1_760_000_000_000, 60, 55));
        await repository.record(decision(1_760_000_000_001, 100, null));
        const client = await getTestPool().connect();
        try {
            await client.query('BEGIN');
            // Reconstruct v25 only in this test file's private schema. Rollback
            // restores the v26 fixture even when an assertion fails.
            await client.query(`ALTER TABLE strategy_decision_log
                DROP CONSTRAINT strategy_decision_log_primary_confidence_finite,
                DROP CONSTRAINT strategy_decision_log_fallback_confidence_finite,
                ALTER COLUMN primary_confidence TYPE INTEGER USING primary_confidence::INTEGER,
                ALTER COLUMN fallback_confidence TYPE INTEGER USING fallback_confidence::INTEGER`);
            const before = await client.query('SELECT * FROM strategy_decision_log ORDER BY created_at');
            for (let replay = 0; replay < 2; replay += 1) {
                await client.query(migration026_decision_confidence_precision.sql);
                expect((await client.query('SELECT * FROM strategy_decision_log ORDER BY created_at')).rows).toEqual(before.rows);
            }
            const columns = await client.query(`SELECT column_name, data_type, is_nullable
                FROM information_schema.columns WHERE table_schema = current_schema()
                AND table_name = 'strategy_decision_log' AND column_name IN ('primary_confidence', 'fallback_confidence')
                ORDER BY column_name`);
            expect(columns.rows).toEqual([
                { column_name: 'fallback_confidence', data_type: 'double precision', is_nullable: 'YES' },
                { column_name: 'primary_confidence', data_type: 'double precision', is_nullable: 'NO' },
            ]);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });

    it.each([NaN, Infinity, -Infinity])('rejects non-finite primary confidence %s at the database boundary', async (confidence) => {
        await expect(repository.record(decision(1_760_000_000_000, confidence, null))).rejects.toMatchObject({
            code: '23514', constraint: 'strategy_decision_log_primary_confidence_finite',
        });
        expect((await getTestPool().query('SELECT * FROM strategy_decision_log')).rows).toHaveLength(0);
    });

    it.each([NaN, Infinity, -Infinity])('rejects non-finite fallback confidence %s at the database boundary', async (confidence) => {
        await expect(repository.record(decision(1_760_000_000_000, 0.375, confidence))).rejects.toMatchObject({
            code: '23514', constraint: 'strategy_decision_log_fallback_confidence_finite',
        });
        expect((await getTestPool().query('SELECT * FROM strategy_decision_log')).rows).toHaveLength(0);
    });

    it('retains optional fallback and refuses a missing required primary confidence', async () => {
        await repository.record(decision(1_760_000_000_000, 0.375, null));
        expect((await getTestPool().query('SELECT primary_confidence, fallback_confidence FROM strategy_decision_log')).rows)
            .toEqual([{ primary_confidence: 0.375, fallback_confidence: null }]);
        await expect(getTestPool().query('UPDATE strategy_decision_log SET primary_confidence = NULL'))
            .rejects.toMatchObject({ code: '23502' });
    });
});
