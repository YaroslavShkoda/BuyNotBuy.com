import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createLease } from './lease.js';

/**
 * The transitions a leader election actually lives through, driven through a
 * fake session rather than a real connection: acquire, contend, verify,
 * lose the session, lose the race, release. The real-database exclusivity —
 * that two processes cannot both hold the lock — is pinned separately, in
 * `lease.db.test.ts`, because a fake that agreed with itself would prove
 * nothing about `pg_try_advisory_lock`.
 */

function silentLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
}

interface FakeQueryResult {
    rows: { locked?: boolean }[];
}

function fakeClient(script: () => Promise<FakeQueryResult>) {
    return {
        query: vi.fn(script),
        release: vi.fn(),
    };
}

function lockedClient(locked: boolean) {
    return fakeClient(async () => ({ rows: [{ locked }] }));
}

type TestClient = ReturnType<typeof fakeClient>;

function leaseWith(clients: TestClient[], logger = silentLogger()) {
    let next = 0;

    const lease = createLease({
        key: 'market-pipeline',
        logger,
        connect: vi.fn(async () => {
            const client = clients[next];
            next += 1;

            if (client === undefined) {
                throw new Error('no more scripted clients');
            }

            return client as unknown as PoolClient;
        }),
    });

    return { lease, logger };
}

describe('lease', () => {
    it('acquires when the lock is free and keeps its own session parked', async () => {
        const client = lockedClient(true);
        const { lease } = leaseWith([client]);

        await expect(lease.ensureHeld()).resolves.toBe(true);

        expect(lease.isHeld).toBe(true);
        expect(client.release).not.toHaveBeenCalled();
        expect(client.query).toHaveBeenCalledWith(
            'SELECT pg_try_advisory_lock($1, $2) AS locked',
            expect.anything(),
        );
    });

    it('reports false and hands the client back when another process leads', async () => {
        const firstAsk = lockedClient(false);
        const secondAsk = lockedClient(false);
        const { lease } = leaseWith([firstAsk, secondAsk]);

        await expect(lease.ensureHeld()).resolves.toBe(false);

        expect(lease.isHeld).toBe(false);
        expect(firstAsk.release).toHaveBeenCalledTimes(1);
        expect(firstAsk.release).toHaveBeenCalledWith();

        // The next tick asks again — that retry is the takeover path — on a
        // fresh session, because a contender parks nothing.
        await expect(lease.ensureHeld()).resolves.toBe(false);
        expect(secondAsk.query).toHaveBeenCalledTimes(1);
    });

    it('verifies on the parked session instead of checking a new one out', async () => {
        const holder = lockedClient(true);
        const { lease } = leaseWith([holder]);

        await expect(lease.ensureHeld()).resolves.toBe(true);
        await expect(lease.ensureHeld()).resolves.toBe(true);

        expect(holder.query).toHaveBeenCalledTimes(2);
        expect(lease.isHeld).toBe(true);
    });

    it('treats a failed verify as a lost lease and takes it back if it can', async () => {
        const logger = silentLogger();
        let dyingCalls = 0;
        const dying = fakeClient(async () => {
            dyingCalls += 1;

            if (dyingCalls === 1) {
                return { rows: [{ locked: true }] };
            }

            throw new Error('connection terminated');
        });
        const heir = lockedClient(true);
        const { lease } = leaseWith([dying, heir], logger);

        await expect(lease.ensureHeld()).resolves.toBe(true);

        await expect(lease.ensureHeld()).resolves.toBe(true);

        // The session died, so the lease died with it — said so once, loudly —
        // and the process re-acquired on a fresh session.
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'lease_lost' }),
            'lease_lost',
        );
        expect(dying.release).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'connection terminated' }),
        );
        expect(heir.release).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'lease_acquired' }),
            'lease_acquired',
        );
    });

    it('stands down when re-acquisition loses the race', async () => {
        let dyingCalls = 0;
        const dying = fakeClient(async () => {
            dyingCalls += 1;

            if (dyingCalls === 1) {
                return { rows: [{ locked: true }] };
            }

            throw new Error('connection terminated');
        });
        const fasterRival = lockedClient(false);
        const { lease } = leaseWith([dying, fasterRival]);

        await expect(lease.ensureHeld()).resolves.toBe(true);
        await expect(lease.ensureHeld()).resolves.toBe(false);

        expect(fasterRival.release).toHaveBeenCalledTimes(1);
        expect(lease.isHeld).toBe(false);
    });

    it('never answers open when the store cannot be consulted', async () => {
        const connect = vi.fn(async () => {
            throw new Error('pool exhausted');
        });
        const lease = createLease({
            key: 'market-pipeline',
            logger: silentLogger(),
            connect,
        });

        await expect(lease.ensureHeld()).rejects.toThrow('pool exhausted');
        expect(lease.isHeld).toBe(false);

        // A rejected acquisition must not leave a half-checked client parked.
        const brokenAcquisition = fakeClient(async () => {
            throw new Error('backend gone');
        });
        const second = createLease({
            key: 'market-pipeline',
            logger: silentLogger(),
            connect: async () => brokenAcquisition as unknown as PoolClient,
        });

        await expect(second.ensureHeld()).rejects.toThrow('backend gone');
        expect(brokenAcquisition.release).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'backend gone' }),
        );
        expect(second.isHeld).toBe(false);
    });

    it('unlocks and unparks its session on release', async () => {
        const holder = lockedClient(true);
        const { lease } = leaseWith([holder]);

        await expect(lease.ensureHeld()).resolves.toBe(true);

        await lease.release();

        expect(holder.query).toHaveBeenCalledWith(
            'SELECT pg_advisory_unlock($1, $2) AS unlocked',
            expect.anything(),
        );
        expect(holder.release).toHaveBeenCalledWith();
        expect(lease.isHeld).toBe(false);

        // Releasing twice is nothing, and a released lease can lead again.
        await expect(lease.release()).resolves.toBeUndefined();
        await expect(lease.ensureHeld()).rejects.toThrow('no more scripted clients');
    });

    it('survives a release whose session died before the unlock', async () => {
        let dyingCalls = 0;
        const dying = fakeClient(async () => {
            dyingCalls += 1;

            if (dyingCalls === 1) {
                return { rows: [{ locked: true }] };
            }

            throw new Error('connection terminated');
        });
        const logger = silentLogger();
        const { lease } = leaseWith([dying], logger);

        await expect(lease.ensureHeld()).resolves.toBe(true);

        await lease.release();

        expect(dying.release).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'connection terminated' }),
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'lease_release_failed' }),
            'lease_release_failed',
        );
        expect(lease.isHeld).toBe(false);
    });

    it('answers overlapping gate calls one at a time', async () => {
        let releaseFirst: (() => void) | undefined;
        let calls = 0;
        const first = fakeClient(async () => {
            calls += 1;

            if (calls === 1) {
                await new Promise<void>((resolve) => {
                    releaseFirst = resolve;
                });
            }

            return { rows: [{ locked: true }] };
        });

        let next = 0;
        const clients = [first];
        const connect = vi.fn(async () => {
            const client = clients[next];
            next += 1;

            if (client === undefined) {
                throw new Error('no more scripted clients');
            }

            return client as unknown as PoolClient;
        });
        const lease = createLease({
            key: 'market-pipeline',
            logger: silentLogger(),
            connect,
        });

        const firstCall = lease.ensureHeld();
        const secondCall = lease.ensureHeld();

        // The serialized job starts on a microtask; let it get as far as the
        // gate inside the scripted client before letting it through.
        await new Promise((resolve) => setImmediate(resolve));

        // The two gate calls overlap, but the acquisition happens once: the
        // loser would otherwise drop the winner's parked session.
        releaseFirst?.();

        await expect(firstCall).resolves.toBe(true);
        await expect(secondCall).resolves.toBe(true);
        expect(connect).toHaveBeenCalledTimes(1);
    });
});
