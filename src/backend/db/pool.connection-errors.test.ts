import { EventEmitter } from 'node:events';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { closePool, getPool, withTransaction } from './pool.js';

describe('pool background connection errors', () => {
    it('rejects a transaction whose session dies while its callback is between queries', async () => {
        const pool = getPool();
        const events = new EventEmitter();
        const client = Object.assign(events, {
            query: vi.fn(async (_sql: string) => ({ rows: [] })),
            release: vi.fn(),
        });
        const connect = vi.spyOn(pool, 'connect').mockImplementation((() => Promise.resolve(client as unknown as PoolClient)) as typeof pool.connect);
        let finish: () => void = () => undefined;
        const work = withTransaction(() => new Promise<void>((done) => { finish = done; }));
        await new Promise((done) => setImmediate(done));
        const failure = new Error('session terminated between callback queries');
        const handled = (() => { try { events.emit('error', failure); return true; } catch { return false; } })();
        finish();
        const outcome = await work.then(() => 'committed', error => error);
        expect(handled).toBe(true);
        expect(outcome).toBe(failure);
        expect(client.query).not.toHaveBeenCalledWith('COMMIT');
        expect(client.release).toHaveBeenCalledExactlyOnceWith(failure);
        connect.mockRestore();
        await closePool();
    });

    it('preserves the callback error when a concurrent session failure also occurs', async () => {
        const pool = getPool();
        const events = new EventEmitter();
        const client = Object.assign(events, {
            query: vi.fn(async (_sql: string) => ({ rows: [] })),
            release: vi.fn(),
        });
        const connect = vi.spyOn(pool, 'connect').mockImplementation((() => Promise.resolve(client as unknown as PoolClient)) as typeof pool.connect);
        const callbackFailure = new Error('original callback failure');
        const sessionFailure = new Error('session failure');
        const work = withTransaction(async () => {
            events.emit('error', sessionFailure);
            throw callbackFailure;
        });
        await expect(work).rejects.toBe(callbackFailure);
        expect(client.release).toHaveBeenCalledExactlyOnceWith(sessionFailure);
        connect.mockRestore();
        await closePool();
    });
    it('handles an idle-client error without exposing connection details or throwing', async () => {
        const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const pool = getPool();
        expect(() => pool.emit('error', new Error('secret connection details'))).not.toThrow();
        expect(warn).toHaveBeenCalledWith('{"event":"database_pool_connection_lost"}\n');
        expect(warn.mock.calls.flat()).not.toContain('secret connection details');
        await closePool();
        warn.mockRestore();
    });
});
