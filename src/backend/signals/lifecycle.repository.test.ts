import { describe, expect, it, beforeEach } from 'vitest';

import { createSignalLifecycleRepository } from './lifecycle.repository.js';
import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';

import type { SignalLifecycleRepository } from './lifecycle.repository.js';
import type { Pool } from 'pg';

const KEY = { symbol: 'BTCUSDT', provider: 'binance', interval: '1h' };
const OTHER = { symbol: 'ETHUSDT', provider: 'binance', interval: '1h' };
const HOUR = 3_600_000;
const NOW = 1_699_999_200_000;

let pool: Pool;
let repository: SignalLifecycleRepository;

beforeEach(async () => {
    pool = getTestPool();
    await truncateSignalTables();
    repository = createSignalLifecycleRepository(
        (text, values) => pool.query(text, values as unknown[]),
    );
});

function write(
    overrides: Partial<Parameters<SignalLifecycleRepository['write']>[2]> = {},
    previous: Parameters<SignalLifecycleRepository['write']>[1] = null,
    reason = 'Открыт LONG',
) {
    return repository.write(
        KEY,
        previous,
        {
            direction: 'LONG',
            status: 'GENERATED',
            price: 100,
            confidence: 70,
            publishedAt: NOW,
            candleTimestamp: NOW,
            ...overrides,
        },
        { reason, createdAt: NOW },
    );
}

describe('the live signal', () => {
    it('is one row per series, however many times it is written', async () => {
        await write();
        await write({ status: 'ACTIVE' }, await repository.getLive(KEY));
        await write({ status: 'UPDATED', price: 105 }, await repository.getLive(KEY));

        const live = await repository.getLive(KEY);

        expect(live?.status).toBe('UPDATED');
        expect(live?.price).toBe(105);
    });

    it('keeps two series apart', async () => {
        await write();
        await repository.write(
            OTHER,
            null,
            {
                direction: 'SHORT',
                status: 'GENERATED',
                price: 50,
                confidence: 60,
                publishedAt: NOW,
                candleTimestamp: NOW,
            },
            { reason: 'Открыт SHORT', createdAt: NOW },
        );

        expect((await repository.getLive(KEY))?.direction).toBe('LONG');
        expect((await repository.getLive(KEY))?.price).toBe(100);
        expect((await repository.getLive(OTHER))?.direction).toBe('SHORT');
    });

    it('is absent for a series that has never signalled', async () => {
        expect(await repository.getLive(OTHER)).toBeNull();
    });

    it('refuses a status the schema does not know', async () => {
        // The constraint is the point of the table: a status the rest of the
        // system cannot interpret must fail at the write, not at the read.
        await expect(
            pool.query(
                `INSERT INTO signal_state (
                    symbol, provider, interval, direction, status,
                    price, confidence, published_at, candle_timestamp,
                    created_at, updated_at
                 ) VALUES ($1, $2, $3, 'LONG', 'MAYBE', 100, 70, $4, $4, $4, $4)`,
                [KEY.symbol, KEY.provider, KEY.interval, NOW],
            ),
        ).rejects.toThrow();
    });

    it('refuses a confidence outside the range it reports in', async () => {
        await expect(
            pool.query(
                `INSERT INTO signal_state (
                    symbol, provider, interval, direction, status,
                    price, confidence, published_at, candle_timestamp,
                    created_at, updated_at
                 ) VALUES ($1, $2, $3, 'LONG', 'ACTIVE', 100, 140, $4, $4, $4, $4)`,
                [KEY.symbol, KEY.provider, KEY.interval, NOW],
            ),
        ).rejects.toThrow();
    });
});

describe('the trail', () => {
    it('records the opening with nothing before it', async () => {
        const state = await write();
        const trail = await repository.transitions(state.id);

        expect(trail).toHaveLength(1);
        expect(trail[0]?.fromStatus).toBeNull();
        expect(trail[0]?.fromDirection).toBeNull();
        expect(trail[0]?.toStatus).toBe('GENERATED');
    });

    it('records where each transition came from', async () => {
        const first = await write();
        const second = await write(
            { status: 'ACTIVE' },
            first,
            'Опубликован',
        );
        const trail = await repository.transitions(second.id);

        expect(trail).toHaveLength(2);
        expect(trail[0]?.fromStatus).toBe('GENERATED');
        expect(trail[0]?.toStatus).toBe('ACTIVE');
        expect(trail[0]?.reason).toBe('Опубликован');
    });

    it('keeps a reversal visible as a change of direction', async () => {
        const first = await write();
        const second = await repository.write(
            KEY,
            first,
            {
                direction: 'SHORT',
                status: 'GENERATED',
                price: 95,
                confidence: 65,
                publishedAt: NOW + HOUR,
                candleTimestamp: NOW + HOUR,
            },
            { reason: 'Разворот в SHORT', createdAt: NOW + HOUR },
        );
        const trail = await repository.transitions(second.id);

        // Same row id, because it is the same series. A different direction,
        // because it is not the same signal — and the outcome engine will
        // measure the two separately.
        expect(second.id).toBe(first.id);
        expect(trail[0]?.fromDirection).toBe('LONG');
        expect(trail[0]?.toDirection).toBe('SHORT');
    });

    it('grows without being rewritten', async () => {
        let state = await write();

        for (let index = 1; index <= 5; index += 1) {
            state = await write(
                { status: 'UPDATED', price: 100 + index },
                state,
                'Обновлён',
            );
        }

        // The live row is one row that gets overwritten; the trail is six
        // appends. Putting them in one table would mean either the poll
        // rewrites history or the trail gets a row a minute.
        const live = await repository.getLive(KEY);
        const trail = await repository.transitions(state.id);

        expect(trail).toHaveLength(6);
        expect(live?.price).toBe(105);
    });

    it('records the bar the transition happened on, not the wall clock', async () => {
        const state = await write({ candleTimestamp: 1_700_000_000_000 });
        const trail = await repository.transitions(state.id);

        // A transition recorded against a wall clock cannot be lined up with
        // the bars that caused it, and lining it up is the entire point.
        expect(trail[0]?.candleTimestamp).toBe(1_700_000_000_000);
    });
});

describe('closed signals', () => {
    it('are the ones an outcome engine can measure', async () => {
        const state = await write();

        await repository.write(
            KEY,
            state,
            {
                direction: 'LONG',
                status: 'INVALIDATED',
                price: 90,
                confidence: 40,
                publishedAt: NOW,
                candleTimestamp: NOW + 10 * HOUR,
            },
            { reason: 'Признан недействительным', createdAt: NOW + 10 * HOUR },
        );

        const closed = await repository.closed(KEY);

        expect(closed).toHaveLength(1);
        expect(closed[0]?.status).toBe('INVALIDATED');
    });

    it('exclude a signal that is still running', async () => {
        await write({ status: 'ACTIVE' });

        expect(await repository.closed(KEY)).toEqual([]);
    });
});

describe('a write is one fact or none of it', () => {
    it('leaves nothing behind when the transition cannot be written', async () => {
        // The trail and the live row are a single fact. A crash between them
        // would leave the trail claiming the signal moved while the live row
        // says it did not, and the outcome engine would measure one thing while
        // the dashboard showed another.
        const broken = createSignalLifecycleRepository(
            (text, values) => pool.query(text, values as unknown[]),
            async (work) => {
                // A real BEGIN and a real ROLLBACK on the borrowed connection,
                // with only the transition insert sabotaged. Without the real
                // transaction the insert would simply commit and the test
                // would be asserting nothing.
                const client = await pool.connect();

                try {
                    await client.query('BEGIN');

                    const fake = {
                        query: async (text: string, values?: readonly unknown[]) => {
                            if (text.includes('signal_transition')) {
                                throw new Error('transition table unavailable');
                            }

                            return client.query(text, values as unknown[]);
                        },
                    };

                    try {
                        return await work(fake as never);
                    } finally {
                        await client.query('ROLLBACK');
                    }
                } finally {
                    client.release();
                }
            },
        );

        await expect(
            broken.write(
                KEY,
                null,
                {
                    direction: 'LONG',
                    status: 'GENERATED',
                    price: 100,
                    confidence: 70,
                    publishedAt: NOW,
                    candleTimestamp: NOW,
                },
                { reason: 'Открыт LONG', createdAt: NOW },
            ),
        ).rejects.toThrow(/transition table unavailable/);

        expect(await repository.getLive(KEY)).toBeNull();
    });
});

describe('retention', () => {
    it('drops old transitions but not those of a live signal', async () => {
        const state = await write();

        await repository.write(
            KEY,
            state,
            {
                direction: 'LONG',
                status: 'ACTIVE',
                price: 101,
                confidence: 70,
                publishedAt: NOW,
                candleTimestamp: NOW + HOUR,
            },
            { reason: 'Обновлён', createdAt: NOW + HOUR },
        );

        await pool.query(
            `UPDATE signal_transition SET created_at = $1 WHERE id IN (
                SELECT id FROM signal_transition ORDER BY created_at ASC LIMIT 1
             )`,
            [NOW - 400 * 24 * HOUR],
        );

        const removed = await repository.deleteBefore(NOW - 200 * 24 * HOUR);

        // The recent one belongs to a signal that is still live, and taking it
        // would leave the live row with no history at all.
        expect(removed).toBe(0);
        expect(await repository.transitions(state.id)).toHaveLength(2);
    });
});
