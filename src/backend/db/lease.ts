import type { PoolClient } from 'pg';

import { getPool } from './pool.js';

/**
 * The market pipeline, one writer at a time, chosen among the processes.
 *
 * Every loop in `server.ts` that writes market data — the analysis poller and
 * each per-market ingestion scheduler — gates every cycle on one shared lease.
 * The lease is a session-level `pg_try_advisory_lock` held on a dedicated
 * client, and session-level is the whole trick: the lock lives on one
 * connection, so it cannot outlive the process that holds it. A crashed
 * leader does not leave a stale lease behind; the database itself releases
 * the lock when the connection dies, and the first contender to ask on its
 * next tick becomes the leader without anyone restarting anything.
 *
 * What the lease deliberately does not do: it does not elect with heartbeats,
 * TTLs or a quorum. There is one database, and it is already the thing every
 * writer coordinates through — a second source of truth for leadership would
 * be one more thing to disagree.
 *
 * **This module is in `db/`, and that is placement, not convenience.** Its
 * whole substance is checking a client out of the pool and holding a session
 * on it — the same substance as `db/pool.ts` and the migration lock in
 * `db/migrations.ts`. Put in `services/`, it would have been a domain-shaped
 * folder around raw connection plumbing, and the layering audit would have
 * been right to name it.
 */

/*
 * Advisory lock key, split into a fixed namespace and a hash of the lease's
 * own name. Any constant will do — its only job is to be distinct from every
 * other advisory pair in this database, including the migration lock's pair
 * in `db/migrations.ts`. Masked to 31 bits so it stays a plain int4.
 */
const LEASE_NAMESPACE = 0x6c656173;

const TRY_LOCK = 'SELECT pg_try_advisory_lock($1, $2) AS locked';
const UNLOCK = 'SELECT pg_advisory_unlock($1, $2) AS unlocked';

/** FNV-1a: a lease name becomes the advisory lock's second key. */
function lockKeyOf(key: string): number {
    let hash = 0x811c9dc5;

    for (let index = 0; index < key.length; index += 1) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }

    return hash & 0x7fffffff;
}

/**
 * The log surface the lease needs, declared here rather than imported from
 * `services/poller.ts`: `db` is a leaf layer, and a type-only edge is still
 * an edge. `app.log` satisfies it structurally, like it satisfies the
 * poller's.
 */
interface LeaseLogger {
    info(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
    warn?(context: Record<string, unknown>, message: string): void;
}

interface LeaseOptions {
    /** Name of the guarded resource, hashed into the lock and kept for logs. */
    readonly key: string;
    readonly logger: LeaseLogger;
    /** Injectable for tests. Defaults to checking a client out of the pool. */
    readonly connect?: () => Promise<PoolClient>;
}

interface Lease {
    /**
     * One cheap query per call, every cycle.
     *
     * True iff this process holds the lease once the call settles. False when
     * another process holds it — the ordinary answer for a contender. Rejects
     * when the lease store cannot be consulted at all: a gate that cannot
     * answer must never be read as an open one, and the caller decides what a
     * closed gate means.
     */
    ensureHeld(): Promise<boolean>;
    /** Best-effort unlock; the dedicated client goes back to the pool. */
    release(): Promise<void>;
    readonly isHeld: boolean;
}

export function createLease(options: LeaseOptions): Lease {
    const connect = options.connect ?? (() => getPool().connect());
    const lockArgs = [LEASE_NAMESPACE, lockKeyOf(options.key)];

    // The dedicated session. The holder parks its own client out of the pool
    // for as long as it leads — one connection is the price of owning the
    // lock — and a contender parks nothing: it checks a client out, asks, and
    // hands it straight back.
    let client: PoolClient | null = null;

    // The analysis poller and every ingestion scheduler share this lease but
    // tick on different intervals, so their gate checks can overlap in time.
    // A pg client queues its own queries, but the bookkeeping between the
    // awaits here does not queue itself: two interleaved calls could both
    // reach acquisition, and the loser would drop `client` out from under the
    // winner. One at a time, always.
    let tail: Promise<unknown> = Promise.resolve();

    function serialize<T>(job: () => Promise<T>): Promise<T> {
        const result = tail.then(job, job);

        tail = result.then(
            () => undefined,
            () => undefined,
        );

        return result;
    }

    async function tryLockOn(target: PoolClient): Promise<boolean> {
        const result = await target.query<{ locked: boolean }>(TRY_LOCK, lockArgs);

        // Re-entrant per session: a holder asking again gets `true` in one
        // query, which is what makes the per-tick verify this cheap.
        return result.rows[0]?.locked === true;
    }

    function dropBroken(target: PoolClient, error: unknown): void {
        // A client whose query failed is a client whose session is gone or
        // going; handing it back with the error lets the pool retire it.
        target.release(error instanceof Error ? error : undefined);
    }

    async function acquire(): Promise<boolean> {
        const fresh = await connect();

        let locked: boolean;

        try {
            locked = await tryLockOn(fresh);
        } catch (error) {
            dropBroken(fresh, error);
            throw error;
        }

        if (!locked) {
            // Someone else leads. The session is healthy, so back to the pool
            // it goes, and the next tick asks again — that retry is what lets
            // this process take over after the current holder dies, without
            // anyone restarting anything.
            fresh.release();

            return false;
        }

        client = fresh;
        options.logger.info(
            { event: 'lease_acquired', key: options.key },
            'lease_acquired',
        );

        return true;
    }

    async function ensureOnce(): Promise<boolean> {
        if (client === null) {
            return acquire();
        }

        const parked = client;

        let verified: boolean;

        try {
            verified = await tryLockOn(parked);
        } catch (error) {
            // The connection died — which is exactly how a session lock dies.
            // The lease went with it, whoever asked next is the leader now,
            // and this process starts over as a contender below.
            client = null;
            dropBroken(parked, error);
            options.logger.error(
                { event: 'lease_lost', key: options.key, err: error },
                'lease_lost',
            );

            return acquire();
        }

        if (verified) {
            return true;
        }

        // A live session reporting the lock gone means it was released out
        // from under us. Nothing in this codebase does that, and being wrong
        // about leading is the one state that must never persist, so it is
        // logged loudly and acted on rather than assumed impossible.
        client = null;
        parked.release();
        options.logger.error(
            { event: 'lease_lost', key: options.key },
            'lease_lost',
        );

        return acquire();
    }

    async function releaseOnce(): Promise<void> {
        const parked = client;
        client = null;

        if (parked === null) {
            return;
        }

        try {
            await parked.query(UNLOCK, lockArgs);
        } catch (error) {
            // The session is on its way out either way: an unlock that cannot
            // run means the connection is gone, and the lock died with it.
            dropBroken(parked, error);
            options.logger.warn?.(
                { event: 'lease_release_failed', key: options.key, err: error },
                'lease_release_failed',
            );

            return;
        }

        parked.release();
        options.logger.info(
            { event: 'lease_released', key: options.key },
            'lease_released',
        );
    }

    return {
        ensureHeld: () => serialize(ensureOnce),
        release: () => serialize(releaseOnce),

        get isHeld(): boolean {
            return client !== null;
        },
    };
}
