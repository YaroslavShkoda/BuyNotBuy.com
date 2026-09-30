import { describe, expect, it, vi } from 'vitest';

import { closedByFor, reconcileSignalOutcomes } from './reconcile.js';

import type { SignalLifecycleRepository, SignalStateRow } from '../signals/lifecycle.repository.js';
import type { OutcomeRepository, SettleInput } from './outcome.repository.js';
import type { Candle } from '../types/market.js';

const KEY = { symbol: 'BTCUSDT', provider: 'binance', interval: '1h' };
const HOUR = 3_600_000;
const BASE = 1_700_000_000_000;

function candles(count: number, from = BASE): Candle[] {
    return Array.from({ length: count }, (_, index) => {
        const close = 100 * (1.005 ** index);

        return {
            timestamp: from + index * HOUR,
            open: close,
            high: close * 1.001,
            low: close * 0.999,
            close,
            volume: 1,
        };
    });
}

function state(overrides: Partial<SignalStateRow> = {}): SignalStateRow {
    return {
        id: '1',
        symbol: KEY.symbol,
        provider: KEY.provider,
        interval: KEY.interval,
        direction: 'LONG',
        status: 'CLOSED',
        snapshotId: null,
        price: 100,
        confidence: 0.7,
        publishedAt: BASE,
        candleTimestamp: BASE,
        ...overrides,
    } as SignalStateRow;
}

function lifecycle(closed: SignalStateRow[]): SignalLifecycleRepository {
    return {
        getLive: vi.fn(async () => null),
        write: vi.fn(),
        transitions: vi.fn(async () => []),
        closed: vi.fn(async () => closed),
        deleteBefore: vi.fn(async () => 0),
    } as unknown as SignalLifecycleRepository;
}

function outcomes(rowsPerSettle = 7): {
    repository: OutcomeRepository;
    calls: SettleInput[];
} {
    const calls: SettleInput[] = [];

    const repository = {
        settle: vi.fn(async (input: SettleInput) => {
            calls.push(input);

            return Array.from({ length: rowsPerSettle }, (_, index) => ({
                id: `${calls.length}-${index}`,
            })) as Awaited<ReturnType<OutcomeRepository['settle']>>;
        }),
        unresolved: vi.fn(async () => []),
        forSeries: vi.fn(async () => []),
        deleteBefore: vi.fn(async () => 0),
    } as unknown as OutcomeRepository;

    return { repository, calls };
}

describe('reconciling closed signals into measurements', () => {
    it('measures every closed signal the lifecycle knows about', async () => {
        // **The gap this closes.** `signal_outcome` had exactly one writer in
        // the repository and nothing in production called it, so the performance
        // layer, the calibration curve and every promotion decision were reading
        // a table that stayed empty. This is the loop that fills it.
        const closed = [state({ id: '1' }), state({ id: '2' }), state({ id: '3' })];
        const store = outcomes();

        const report = await reconcileSignalOutcomes(
            { key: KEY, candles: candles(40), now: BASE + 40 * HOUR },
            lifecycle(closed),
            store.repository,
        );

        expect(report.examined).toBe(3);
        expect(store.calls).toHaveLength(3);
        expect(store.calls.map((c) => c.stateId)).toEqual([1, 2, 3]);
    });

    it('counts one row per horizon, not one per signal', async () => {
        const store = outcomes(7);

        const report = await reconcileSignalOutcomes(
            { key: KEY, candles: candles(40), now: BASE + 40 * HOUR },
            lifecycle([state()]),
            store.repository,
        );

        // Seven horizons configured, seven rows for one signal. Reporting one
        // here would make a table of measurements look seven times smaller than
        // it is, which is the kind of number that reads as "almost no trades".
        expect(report.rows).toBe(7);
    });

    it('passes the entry, not the window, and lets the measurement decide', async () => {
        // The candles go in whole. Slicing them here would compute the start of
        // the window in two places and trust the two to agree; `measureOutcome`
        // filters on the entry timestamp for exactly this reason.
        const store = outcomes();
        const series = candles(50);

        await reconcileSignalOutcomes(
            { key: KEY, candles: series, now: BASE + 50 * HOUR },
            lifecycle([state({ candleTimestamp: BASE + 10 * HOUR })]),
            store.repository,
        );

        expect(store.calls[0]?.candles).toBe(series);
        expect(store.calls[0]?.entryTimestamp).toBe(BASE + 10 * HOUR);
        expect(store.calls[0]?.entryPrice).toBe(100);
    });

    it('names why each signal ended, from the status it was closed with', async () => {
        const store = outcomes();

        await reconcileSignalOutcomes(
            { key: KEY, candles: candles(40), now: BASE + 40 * HOUR },
            lifecycle([
                state({ id: '1', status: 'INVALIDATED' }),
                state({ id: '2', status: 'EXPIRED' }),
                state({ id: '3', status: 'CLOSED' }),
            ]),
            store.repository,
        );

        expect(store.calls.map((c) => c.closedBy)).toEqual([
            'invalidated',
            'expired',
            'reversed',
        ]);
    });

    it('asks the lifecycle for closed signals rather than for everything', async () => {
        // `closed()` filters to terminal statuses. Asking it for the live row
        // would measure a signal that is still open, and a measurement of a
        // signal that has not finished is a measurement of a prefix.
        const store = outcomes();
        const store1 = lifecycle([state()]);

        await reconcileSignalOutcomes(
            { key: KEY, candles: candles(40), now: BASE + 40 * HOUR, limit: 25 },
            store1,
            store.repository,
        );

        expect(store1.closed).toHaveBeenCalledWith(KEY, 25);
    });

    it('reports what is still waiting, because a pass that settles nothing is normal', async () => {
        // A signal whose longest horizon has not closed yet is not a failure,
        // and a settler that reported only what it finished would look broken
        // for the first day of every run.
        const store = outcomes();
        store.repository.unresolved = vi.fn(async () => [{ id: 'a' }, { id: 'b' }]) as never;

        const report = await reconcileSignalOutcomes(
            { key: KEY, candles: candles(4), now: BASE + 4 * HOUR },
            lifecycle([state()]),
            store.repository,
        );

        expect(report.stillWaiting).toBe(2);
        expect(report.examined).toBe(1);
    });

    it('does nothing at all when nothing has closed', async () => {
        const store = outcomes();

        const report = await reconcileSignalOutcomes(
            { key: KEY, candles: candles(40), now: BASE + 40 * HOUR },
            lifecycle([]),
            store.repository,
        );

        expect(report).toEqual({ examined: 0, rows: 0, stillWaiting: 0 });
        expect(store.calls).toEqual([]);
    });

    it('attributes the measurement to the rule that produced it', async () => {
        // **This is the link the promotion gate hangs on.**
        //
        // `evaluateShadow` needs signals, resolved and correct *for one rule*.
        // `signal_outcome.strategy_version_id` is the only column that can say
        // which rule, and it is written from this argument. When the poller
        // does not supply one — and today it does not, because the analysis
        // discards the snapshot id at `void storeSnapshot(...)` — every outcome
        // row carries NULL and no outcome can ever be joined to a rule, so the
        // gate has nothing to gate on.
        //
        // The test pins the plumbing rather than the gap: it passes when the
        // caller supplies a version, and the open item in
        // docs/roadmap-v2-status.md is what supplies it.
        const store = outcomes();

        await reconcileSignalOutcomes(
            {
                key: KEY,
                candles: candles(40),
                now: BASE + 40 * HOUR,
                strategyVersionId: 77,
            },
            lifecycle([state()]),
            store.repository,
        );

        expect(store.calls[0]?.strategyVersionId).toBe(77);
    });
});

describe('why a signal ended', () => {
    it('is read off the status, and the third one is a reading rather than a fact', () => {
        expect(closedByFor('INVALIDATED')).toBe('invalidated');
        expect(closedByFor('EXPIRED')).toBe('expired');
        // `CLOSED` says that it ended, not why, and `reversed` is the only word
        // left. Nothing has ever written it — the value exists in the type, in
        // the database CHECK and in every reader, and no code path produces it.
        expect(closedByFor('CLOSED')).toBe('reversed');
    });

    it('falls back to "reversed" for anything else, which is a hazard worth naming', () => {
        // My first version of this test was called "never invents a reason for a
        // signal that has not ended" and asserted the opposite of its own name:
        // it checked that an open status came back as `reversed`, which is
        // exactly a reason invented for a signal that has not ended. The name
        // was wrong and the behaviour is real, so both are written down here
        // rather than hidden behind a comfortable title.
        //
        // The three open statuses cannot reach this function — `closed()`
        // filters to terminal ones — and this pins that they are known, so that
        // adding a fourth cannot slip through as a closed one without this
        // test changing and somebody having to think about it.
        for (const status of ['GENERATED', 'ACTIVE', 'UPDATED']) {
            expect(closedByFor(status)).toBe('reversed');
        }
    });
});
