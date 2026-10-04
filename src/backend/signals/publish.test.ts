import { describe, expect, it, vi } from 'vitest';
import type { SignalLifecycleRepository, SignalStateRow } from './lifecycle.repository.js';
import { publishSignal } from './publish.js';

const KEY = { symbol: 'BTCUSDT', provider: 'binance', interval: '1h' };
const HOUR = 3_600_000;
const BAR = 1_700_000_000_000;

function state(overrides: Partial<SignalStateRow> = {}): SignalStateRow {
    return {
        id: '1',
        symbol: KEY.symbol,
        provider: KEY.provider,
        interval: KEY.interval,
        direction: 'LONG',
        status: 'GENERATED',
        snapshotId: null,
        price: 100,
        confidence: 0.7,
        publishedAt: BAR,
        candleTimestamp: BAR,
        ...overrides,
    } as SignalStateRow;
}

function lifecycle(live: SignalStateRow | null) {
    const written: unknown[] = [];

    const repository = {
        getLive: vi.fn(async () => live),
        write: vi.fn(async (key: unknown, previous: unknown, write: unknown, transition: unknown) => {
            written.push({ key, previous, write, transition });

            return state({ id: '2', ...(write as object) }) as SignalStateRow;
        }),
        transitions: vi.fn(async () => []),
        closed: vi.fn(async () => []),
        deleteBefore: vi.fn(async () => 0),
    } as unknown as SignalLifecycleRepository;

    return { repository, written };
}

const candidate = {
    direction: 'LONG' as const,
    confidence: 0.8,
    price: 105,
    candleTimestamp: BAR + 10 * HOUR,
};

describe('publishing the panel into the lifecycle', () => {
    it('opens a signal when nothing is live and the panel has an opinion', async () => {
        // The row this writes is the only thing `closed()` can ever return, so
        // without it the settlement loop has nothing to measure. That loop has
        // been running on every poll since it was wired, against an empty
        // source, because this is where the first row would have come from.
        const store = lifecycle(null);

        const result = await publishSignal(
            { key: KEY, candidate, intervalMs: HOUR, candleTimestamp: candidate.candleTimestamp },
            store.repository,
        );

        expect(result.written).toBe(true);
        expect(result.kind).toBe('open');
        expect(result.toStatus).toBe('GENERATED');
        expect(store.written).toHaveLength(1);
    });

    it('stamps the signal with the bar, never with the clock', async () => {
        // The lifecycle module makes the rule in its own comment: a rule that
        // reaches for the wall clock cannot be replayed over last month's data.
        // `Date.now()` would fill the column and quietly destroy that — replay
        // March would claim every signal moved today, and nothing would look
        // wrong. So both the row and the transition carry the bar.
        const store = lifecycle(null);

        const before = Date.now();
        await publishSignal({ key: KEY, candidate, intervalMs: HOUR, candleTimestamp: candidate.candleTimestamp }, store.repository);

        const call = store.written[0] as {
            write: { publishedAt: number; candleTimestamp: number };
            transition: { createdAt: number };
        };

        expect(call.write.publishedAt).toBe(BAR + 10 * HOUR);
        expect(call.write.candleTimestamp).toBe(BAR + 10 * HOUR);
        expect(call.transition.createdAt).toBe(BAR + 10 * HOUR);
        // A wall clock would have landed in this window instead.
        expect(call.write.publishedAt).toBeLessThan(before);
        expect(call.write.publishedAt).toBeGreaterThan(0);
    });

    it('writes nothing when the panel says nothing new', async () => {
        // `unchanged` is the common outcome, not a failure. A publisher that
        // wrote a row every poll would fill the transition table with noise and
        // make every duration a measure of the polling interval.
        const store = lifecycle(
            state({ direction: 'LONG', price: 105, confidence: 0.8, candleTimestamp: BAR + 10 * HOUR }),
        );

        const result = await publishSignal(
            { key: KEY, candidate: { ...candidate, price: 105.01 }, intervalMs: HOUR, candleTimestamp: candidate.candleTimestamp },
            store.repository,
        );

        expect(result.written).toBe(false);
        expect(store.written).toHaveLength(0);
        // The row is still there. Absence of a write is not absence of a signal.
        expect(result.live).not.toBeNull();
    });

    it('closes an expired signal at the price the signal actually held', async () => {
        // This is the one that feeds the outcome engine, so the entry it
        // records is the entry that gets measured. Taking the candidate's price
        // here would put an exit in the table with an entry the signal never
        // held, and the performance table would grade a trade nobody took.
        const live = state({
            direction: 'LONG',
            status: 'ACTIVE',
            price: 100,
            confidence: 0.7,
            candleTimestamp: BAR,
        });
        const store = lifecycle(live);

        // Far enough ahead that the signal has run out of bars on its own.
        const result = await publishSignal(
            { key: KEY, candidate: null, intervalMs: HOUR, candleTimestamp: BAR + 99 * HOUR },
            store.repository,
        );

        expect(result.written).toBe(true);
        expect(['expire', 'invalidate']).toContain(result.kind);

        const call = store.written[0] as { write: { price: number; confidence: number; direction: string } };
        expect(call.write.price).toBe(100);
        expect(call.write.confidence).toBe(0.7);
        expect(call.write.direction).toBe('LONG');
    });

    it('passes the previous row to the write, so one transaction can hold both', async () => {
        // The repository writes the live row and its transition in one
        // transaction precisely because they are a single fact. Handing it the
        // previous row is what lets it tell "moved from X" from "moved from
        // nothing", and that difference is the whole transition trail.
        const live = state({ status: 'GENERATED' });
        const store = lifecycle(live);

        await publishSignal(
            { key: KEY, candidate: { ...candidate, direction: 'SHORT' }, intervalMs: HOUR, candleTimestamp: candidate.candleTimestamp },
            store.repository,
        );

        expect((store.written[0] as { previous: unknown }).previous).toBe(live);
    });

    it('carries the snapshot through, so a signal points at what produced it', async () => {
        const store = lifecycle(null);

        await publishSignal(
            { key: KEY, candidate, intervalMs: HOUR, candleTimestamp: candidate.candleTimestamp, snapshotId: 'snap-42' },
            store.repository,
        );

        expect((store.written[0] as { write: { snapshotId: string } }).write.snapshotId).toBe(
            'snap-42',
        );
    });

    it('keeps the original snapshot when a signal is republished or closed', async () => {
        // **This is the case that broke attribution.** The closing write had no
        // snapshot of its own and wrote NULL over the one the open had recorded,
        // so every closed signal was unattributable and every outcome row came
        // back with a null rule — silently, because null is a legal value in
        // that column and the row looked complete.
        //
        // A signal is measured from the bar it stood on, and the snapshot
        // holding that bar is what names the rule. Neither a price move nor the
        // end of the signal changes either of those two things.
        const store = lifecycle(state({ status: 'GENERATED', snapshotId: 'snap-7' }));

        await publishSignal(
            { key: KEY, candidate: null, intervalMs: HOUR, candleTimestamp: BAR + 99 * HOUR },
            store.repository,
        );

        expect((store.written[0] as { write: { snapshotId: string } }).write.snapshotId).toBe(
            'snap-7',
        );
    });
});
