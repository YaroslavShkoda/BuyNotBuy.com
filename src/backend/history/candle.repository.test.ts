import { beforeEach, describe, expect, it } from 'vitest';

import '../test-support/test-database.js';

import { createCandleRepository } from './candle.repository.js';

import type { CandleSeriesKey } from './candle.repository.js';
import type { Candle } from '../types/market.js';

/**
 * The table a result is later measured against, so the questions that matter
 * are not "does the row come back" but "can two readers disagree about what
 * was stored, and can the same reader get a different answer twice".
 */

const HOUR = 3_600_000;
const BASE = 1_700_000_000_000;

const BTC: CandleSeriesKey = {
    provider: 'binance',
    symbol: 'BTCUSDT',
    interval: '1h',
};

/**
 * A bar whose parts always agree with each other.
 *
 * Built from the close outwards, so an override like `{ close: 105 }` moves the
 * open, high and low with it. A fixture that fixed the high and let the close
 * float would fail the table's own check for reasons that have nothing to do
 * with what each test is about, and the failure would be about the fixture.
 */
function bar(
    index: number,
    overrides: Partial<Candle> = {},
): Candle {
    const close = overrides.close ?? 100 + index + 0.5;
    const open = overrides.open ?? close - 0.25;

    return {
        timestamp: overrides.timestamp ?? BASE + index * HOUR,
        open,
        high: overrides.high ?? Math.max(open, close) + 1,
        low: overrides.low ?? Math.min(open, close) - 1,
        close,
        volume: overrides.volume ?? 10 + index,
    };
}

const repository = createCandleRepository();

describe('CandleRepository', () => {
    it('stores a bar and reads it back whole', async () => {
        await expect(repository.upsert(BTC, bar(0))).resolves.toBe(true);

        const stored = await repository.getLatest(BTC);

        expect(stored).toMatchObject({
            provider: 'binance',
            symbol: 'BTCUSDT',
            interval: '1h',
            timestamp: BASE,
            open: 100.25,
            high: 101.5,
            low: 99.25,
            close: 100.5,
            volume: 10,
            isClosed: true,
        });
        expect(stored?.ingestedAt).toBeGreaterThan(0);
    });

    it('reports an empty series as empty rather than as a zero bar', async () => {
        expect(await repository.getLatest(BTC)).toBeNull();
        expect(await repository.getRange(BTC, 0, BASE * 10)).toEqual([]);
        expect(await repository.count(BTC)).toBe(0);
    });

    it('keeps one series per venue, even for the same hour', async () => {
        // Binance and Bitget print different numbers for the same hour. Keyed
        // only by time, the table would keep whichever row arrived last, and a
        // switch of venue mid-outage would rewrite history instead of recording
        // it — which is the one thing a result measured later relies on not
        // having happened.
        await repository.upsert(BTC, bar(0, { close: 100 }));
        await repository.upsert(
            { ...BTC, provider: 'bitget' },
            bar(0, { close: 200 }),
        );

        expect(await repository.count(BTC)).toBe(1);
        expect(await repository.count({ ...BTC, provider: 'bitget' })).toBe(1);
        expect((await repository.getLatest(BTC))?.close).toBe(100);
        expect(
            (await repository.getLatest({ ...BTC, provider: 'bitget' }))?.close,
        ).toBe(200);
    });

    it('keeps intervals apart', async () => {
        await repository.upsert(BTC, bar(0));
        await repository.upsert({ ...BTC, interval: '4h' }, bar(0));

        expect(await repository.count(BTC)).toBe(1);
        expect(await repository.count({ ...BTC, interval: '4h' })).toBe(1);
    });

    it('lets a provider revise a bar it already sent', async () => {
        await repository.upsert(BTC, bar(0, { close: 100 }));
        await repository.upsert(BTC, bar(0, { close: 105 }));

        expect(await repository.count(BTC)).toBe(1);
        expect((await repository.getLatest(BTC))?.close).toBe(105);
    });

    it('records when a revision arrived, not only when the bar did', async () => {
        await repository.upsert(BTC, bar(0));
        const first = await repository.getLatest(BTC);

        await new Promise((resolve) => setTimeout(resolve, 5));

        await repository.upsert(BTC, bar(0, { close: 105 }));
        const second = await repository.getLatest(BTC);

        // Keeping the first arrival would make a table of revisions
        // indistinguishable from a table of first readings.
        expect(second?.ingestedAt).toBeGreaterThan(first?.ingestedAt ?? 0);
    });

    describe('closed and forming', () => {
        it('hides a forming bar from an ordinary read', async () => {
            await repository.upsert(BTC, bar(0));
            await repository.upsert(BTC, bar(1), { isClosed: false });

            // A forming bar is a partial bar: its close keeps moving. A backtest
            // that read one would compute indicators from data that did not
            // exist when the decision was made.
            expect(await repository.count(BTC)).toBe(1);
            expect((await repository.getLatest(BTC))?.timestamp).toBe(BASE);
        });

        it('shows a forming bar to the caller that asks for it', async () => {
            await repository.upsert(BTC, bar(0));
            await repository.upsert(BTC, bar(1), { isClosed: false });

            const withForming = await repository.getRange(BTC, 0, BASE * 10, {
                closedOnly: false,
            });

            expect(withForming).toHaveLength(2);
            expect(withForming[1]?.isClosed).toBe(false);
        });

        it('closes a forming bar when the final one arrives', async () => {
            await repository.upsert(BTC, bar(1), { isClosed: false });
            await repository.upsert(BTC, bar(1, { close: 101 }), {
                isClosed: true,
            });

            expect(await repository.count(BTC)).toBe(1);
            expect((await repository.getLatest(BTC))?.close).toBe(101);
        });

        it('never re-opens a bar that has closed', async () => {
            // The direction matters. A provider that later serves a partial view
            // of an hour that is already finished must not drag that hour back
            // into "still forming" — every reader that asks for closed bars
            // would suddenly be short one, and a backfill filling the gap would
            // then write a different value for the same bar.
            await repository.upsert(BTC, bar(1, { close: 101 }), {
                isClosed: true,
            });

            const written = await repository.upsert(
                BTC,
                bar(1, { close: 999 }),
                { isClosed: false },
            );

            expect(written).toBe(false);

            const stored = await repository.getLatest(BTC);

            expect(stored?.isClosed).toBe(true);
            expect(stored?.close).toBe(101);
            expect(await repository.count(BTC)).toBe(1);
        });
    });

    describe('reads', () => {
        beforeEach(async () => {
            await repository.bulkUpsert(BTC, Array.from({ length: 10 }, (_, i) => bar(i)));
        });

        it('returns a range oldest first and includes both ends', async () => {
            const rows = await repository.getRange(BTC, BASE, BASE + 4 * HOUR);

            expect(rows.map((row) => row.timestamp)).toEqual([
                BASE,
                BASE + HOUR,
                BASE + 2 * HOUR,
                BASE + 3 * HOUR,
                BASE + 4 * HOUR,
            ]);
        });

        it('returns nothing for a range that is entirely in the future', async () => {
            expect(await repository.getRange(BTC, BASE * 100, BASE * 200)).toEqual(
                [],
            );
        });

        it('walks backwards from a timestamp, newest first', async () => {
            const rows = await repository.getBefore(BTC, BASE + 4 * HOUR, 2);

            expect(rows.map((row) => row.timestamp)).toEqual([
                BASE + 3 * HOUR,
                BASE + 2 * HOUR,
            ]);
        });

        it('excludes the timestamp itself from both directions', async () => {
            const before = await repository.getBefore(BTC, BASE + 2 * HOUR, 50);
            const after = await repository.getAfter(BTC, BASE + 2 * HOUR, 50);

            expect(before.every((row) => row.timestamp < BASE + 2 * HOUR)).toBe(true);
            expect(after.every((row) => row.timestamp > BASE + 2 * HOUR)).toBe(true);
        });

        it('walks forwards from a timestamp, oldest first', async () => {
            const rows = await repository.getAfter(BTC, BASE + 7 * HOUR, 5);

            expect(rows.map((row) => row.timestamp)).toEqual([
                BASE + 8 * HOUR,
                BASE + 9 * HOUR,
            ]);
        });

        it('reports a limit of zero as no rows rather than as everything', async () => {
            expect(await repository.getAfter(BTC, BASE, 0)).toEqual([]);
            expect(await repository.getBefore(BTC, BASE + 9 * HOUR, 0)).toEqual([]);
        });

        it('hands back a value no caller can write through', async () => {
            const first = await repository.getLatest(BTC);

            expect(first?.close).toBe(109.5);

            // The row mapping is the only place a stored bar becomes a returned
            // one, so a caller that edits what it was given edits its own copy
            // and not the table. A repository handing back the driver's own row
            // objects would make the second read agree with the edit.
            (first as { close: number }).close = 1;

            expect((await repository.getLatest(BTC))?.close).toBe(109.5);
        });
    });

    describe('bulkUpsert', () => {
        it('writes a whole page and reports how many rows it touched', async () => {
            const written = await repository.bulkUpsert(
                BTC,
                Array.from({ length: 25 }, (_, i) => bar(i)),
            );

            expect(written).toBe(25);
            expect(await repository.count(BTC)).toBe(25);
        });

        it('accepts an empty page without touching the database', async () => {
            expect(await repository.bulkUpsert(BTC, [])).toBe(0);
        });

        it('is idempotent, so a retried page is not a duplicated one', async () => {
            const page = Array.from({ length: 10 }, (_, i) => bar(i));

            await repository.bulkUpsert(BTC, page);
            await repository.bulkUpsert(BTC, page);

            // A backfill that is retried after a timeout must not double a
            // history. The unique constraint is what makes that true; this is
            // the assertion that it is still true.
            expect(await repository.count(BTC)).toBe(10);
        });

        it('writes across more rows than fit in one statement', async () => {
            const page = Array.from({ length: 2_100 }, (_, i) => bar(i));

            const written = await repository.bulkUpsert(BTC, page);

            expect(written).toBe(2_100);
            expect(await repository.count(BTC)).toBe(2_100);
        });

        it('gives every row of a page the same arrival time', async () => {
            await repository.bulkUpsert(BTC, [bar(0), bar(1)]);
            await new Promise((resolve) => setTimeout(resolve, 5));
            await repository.bulkUpsert(BTC, [bar(2), bar(3)]);

            const rows = await repository.getRange(BTC, BASE, BASE + 4 * HOUR);
            const arrivals = new Set(rows.map((row) => row.ingestedAt));

            // A page is one observation of the market, and the moment it was
            // taken is a fact about the page rather than about each bar in it.
            expect(arrivals.size).toBe(2);
        });
    });

    describe('what the table refuses', () => {
        it('refuses a bar whose high is below its low', async () => {
            // Caught here rather than by a later read, because a series like
            // this one makes every indicator downstream wrong in a way that is
            // expensive to trace back to a single bad row.
            await expect(
                repository.upsert(BTC, bar(0, { high: 50, low: 90 })),
            ).rejects.toThrow();
        });

        it('refuses a bar whose close is outside its own range', async () => {
            await expect(
                repository.upsert(BTC, bar(0, { close: 200, high: 101 })),
            ).rejects.toThrow();
        });

        it('refuses a negative volume', async () => {
            await expect(
                repository.upsert(BTC, bar(0, { volume: -1 })),
            ).rejects.toThrow();
        });

        it('refuses a price of zero', async () => {
            await expect(
                repository.upsert(BTC, bar(0, { low: 0 })),
            ).rejects.toThrow();
        });

        it('refuses a bar written without an arrival time', async () => {
            // Not reachable through the repository, which always stamps one.
            // Checked because a raw insert that skipped it would make the table
            // impossible to reason about later: a revision is only meaningful
            // against a moment.
            await expect(
                repository.upsert(BTC, bar(0, { timestamp: Number.NaN })),
            ).rejects.toThrow();
        });

        it('leaves the table untouched when a page contains one bad row', async () => {
            await expect(
                repository.bulkUpsert(BTC, [bar(0), bar(1, { high: 1, low: 99 })]),
            ).rejects.toThrow();

            // One statement, so one bad bar costs the whole page and leaves no
            // half-written history behind. A backfill that had written the good
            // rows first would leave a gap it had no record of making.
            expect(await repository.count(BTC, { closedOnly: false })).toBe(0);
        });
    });
});
