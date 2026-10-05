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
