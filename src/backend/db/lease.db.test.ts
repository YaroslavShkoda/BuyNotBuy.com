import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getTestPool } from '../test-support/test-database.js';
import { createLease } from './lease.js';

/**
 * The one thing a fake cannot prove: that the database grants the lock to
 * exactly one of two live sessions, and hands it to the survivor when the
 * holder lets go. This is the property the whole single-writer guarantee
 * rests on, so it is checked against the real `pg_try_advisory_lock`.
 */

const logger = {
    info: () => undefined,
    error: () => undefined,
    warn: () => undefined,
};

let first: ReturnType<typeof createLease>;
let second: ReturnType<typeof createLease>;

beforeAll(() => {
    const connect = async () => getTestPool().connect();

    first = createLease({ key: 'lease-db-test', logger, connect });
    second = createLease({ key: 'lease-db-test', logger, connect });
});

afterAll(async () => {
    // The pool itself is closed by test-support/test-database.ts; the leases
    // only have to let go of their parked sessions first, which this hook —
    // registered later — is run before that one.
    await first.release();
    await second.release();
});

describe('lease, against the real lock', () => {
    it('hands off to a distinct session after repeated holder checks and one release', async () => {
        const holders = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
        const contenders = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
        const holder = createLease({ key: 'repeated-check-handoff', logger, connect: () => holders.connect() });
        const contender = createLease({ key: 'repeated-check-handoff', logger, connect: () => contenders.connect() });
        try {
            const holderPid = (await holders.query('SELECT pg_backend_pid() pid')).rows[0].pid;
            const contenderPid = (await contenders.query('SELECT pg_backend_pid() pid')).rows[0].pid;
            expect(holderPid).not.toBe(contenderPid);
            await expect(holder.ensureHeld()).resolves.toBe(true);
            await expect(holder.ensureHeld()).resolves.toBe(true);
            await expect(holder.ensureHeld()).resolves.toBe(true);
            await expect(contender.ensureHeld()).resolves.toBe(false);
            await holder.release();
            await expect(contender.ensureHeld()).resolves.toBe(true);
        } finally {
            await holder.release();
            await contender.release();
            await holders.end();
            await contenders.end();
        }
    });
    it('grants the lease to one process and to no one else', async () => {
        await expect(first.ensureHeld()).resolves.toBe(true);
        expect(first.isHeld).toBe(true);

        // A session-level lock is exclusive across sessions: the second lease
        // — the second process, in production — asks and is told no.
        await expect(second.ensureHeld()).resolves.toBe(false);
        expect(second.isHeld).toBe(false);

        // The holder keeps asking, as the poller does every cycle, and keeps
        // leading; the contender keeps asking, as its own poller does, and
        // keeps standing down. Neither answer drifts with repetition.
        await expect(first.ensureHeld()).resolves.toBe(true);
        await expect(second.ensureHeld()).resolves.toBe(false);
    });

    it('hands the lease over once the holder releases it', async () => {
        await expect(first.ensureHeld()).resolves.toBe(true);

        await first.release();

        await expect(second.ensureHeld()).resolves.toBe(true);
        expect(second.isHeld).toBe(true);

        // And the roles cannot both be what they just were: the old holder is
        // a contender now.
        await expect(first.ensureHeld()).resolves.toBe(false);

        await second.release();
    });
});
