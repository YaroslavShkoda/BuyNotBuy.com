import { beforeEach, describe, expect, it } from 'vitest';

import '../../test-support/test-database.js';

import {
    getTestPool,
    truncateSignalTables,
} from '../../test-support/test-database.js';
import type { IndicatorVote } from './indicator-performance.types.js';
import { createIndicatorVoteRepository } from './indicator-vote.repository.js';

const HOUR = 3_600_000;
const BASE = 1_700_000_000_000;

const BTC = 'BTCUSDT';
const ETH = 'ETHUSDT';

function vote(symbol: string, bucket: number, indicator: string): IndicatorVote {
    return {
        symbol,
        timestamp: BASE + bucket * HOUR,
        indicator,
        signal: 'LONG',
        weight: 0.5,
        price: 100_000,
        fwdReturns: {},
    } as IndicatorVote;
}

async function countFor(symbol: string): Promise<number> {
    const result = await getTestPool().query(
        'SELECT COUNT(*)::int AS total FROM indicator_vote WHERE symbol = $1',
        [symbol],
    );

    return result.rows[0]?.total as number;
}

describe('trimming recorded votes', () => {
    beforeEach(async () => {
        await truncateSignalTables();
    });

    it('leaves another asset untouched', async () => {
        const repository = createIndicatorVoteRepository({ maxEntries: 2 });

        // ETH has three buckets, more than the budget. BTC is the asset that
        // arrives afterwards, and it is the one that must not be able to spend
        // ETH's history.
        await repository.record([
            vote(ETH, 1, 'ema'),
            vote(ETH, 2, 'ema'),
            vote(ETH, 3, 'ema'),
        ]);
        const ethBefore = await countFor(ETH);

        expect(ethBefore).toBeGreaterThan(0);

        await repository.record([vote(BTC, 4, 'ema')]);

        // The whole defect in one assertion: recording for one market must not
        // delete another market's rows. Before the fix this was 0, silently.
        expect(await countFor(ETH)).toBe(ethBefore);
        expect(await countFor(BTC)).toBe(1);
    });

    it('still drops the oldest buckets of the asset it is trimming', async () => {
        const repository = createIndicatorVoteRepository({ maxEntries: 2 });

        await repository.record([
            vote(BTC, 1, 'ema'),
            vote(BTC, 2, 'ema'),
            vote(BTC, 3, 'ema'),
        ]);

        // The trim is what keeps the table bounded. A fix that stopped trimming
        // would pass the test above and quietly become an unbounded table.
        expect(await countFor(BTC)).toBe(2);

        const kept = await repository.list(BTC, 10);
        const buckets = [
            ...new Set(
                kept.map((row) => Math.floor(row.timestamp / HOUR)),
            ),
        ];

        expect(buckets.sort((a, b) => a - b)).toEqual([
            Math.floor((BASE + 2 * HOUR) / HOUR),
            Math.floor((BASE + 3 * HOUR) / HOUR),
        ]);
    });

    it('gives each asset in one batch its own budget', async () => {
        const repository = createIndicatorVoteRepository({ maxEntries: 2 });

        // A batch is allowed to carry more than one symbol. Trimming once for
        // the batch would rank both assets against each other and keep the
        // newest two buckets overall, which for two assets means keeping
        // almost nothing of either.
        await repository.record([
            vote(BTC, 1, 'ema'),
            vote(BTC, 2, 'ema'),
            vote(BTC, 3, 'ema'),
            vote(ETH, 1, 'ema'),
            vote(ETH, 2, 'ema'),
            vote(ETH, 3, 'ema'),
        ]);

        expect(await countFor(BTC)).toBe(2);
        expect(await countFor(ETH)).toBe(2);
    });

    it('reports a trim that removed nothing as a normal write', async () => {
        const repository = createIndicatorVoteRepository({ maxEntries: 50 });

        await repository.record([vote(BTC, 1, 'ema')]);
        await repository.record([vote(BTC, 2, 'ema')]);

        // The write path is unchanged for the single-asset case it had before:
        // same rows, no error, no second copy of a row.
        expect(await countFor(BTC)).toBe(2);
    });
});
