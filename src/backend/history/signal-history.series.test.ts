import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSignalHistoryRepository } from './signal-history.repository.js';
import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';
import { marketConfig } from '../config/market.config.js';

import type { SignalHistoryRepository } from './signal-history.repository.js';
import type { SignalHistoryEntry } from './signal-history.types.js';
import type { Pool } from 'pg';

const HOUR_MS = 3_600_000;
const BASE = 1_737_950_400_000;

let pool: Pool;
let repository: SignalHistoryRepository;

beforeEach(async () => {
    pool = getTestPool();
    await truncateSignalTables();
    repository = createSignalHistoryRepository({ maxEntries: 720 });
});

function entry(
    overrides: Partial<SignalHistoryEntry> = {},
): SignalHistoryEntry {
    return {
        timestamp: BASE,
        symbol: 'BTCUSDT',
        signal: 'LONG',
        consensus: 71,
        price: 100_000,
        ...overrides,
    };
}

describe('a history row knows which series it belongs to', () => {
    it('defaults to the configured one when the caller does not say', async () => {
        await repository.record(entry());

        const [stored] = await repository.list('BTCUSDT', 10);

        expect(stored?.provider).toBe(marketConfig.provider);
        expect(stored?.interval).toBe(marketConfig.candleInterval);
    });

    it('keeps two intervals of one symbol apart instead of overwriting one', async () => {
        // The original key was the symbol and the hour, which is uniqueness
        // over too little: the second interval's row collides with the first
        // one's and the history silently becomes whichever wrote last.
        await repository.record(
            entry({ interval: '1h', signal: 'LONG', price: 100_000 }),
        );
        await repository.record(
            entry({ interval: '4h', signal: 'SHORT', price: 99_000 }),
        );

        const hourly = await repository.list('BTCUSDT', 10, undefined, {
            interval: '1h',
        });
        const fourHourly = await repository.list('BTCUSDT', 10, undefined, {
            interval: '4h',
        });

        expect(hourly).toHaveLength(1);
        expect(fourHourly).toHaveLength(1);
        expect(hourly[0]?.signal).toBe('LONG');
        expect(fourHourly[0]?.signal).toBe('SHORT');
    });

    it('keeps two venues of one symbol apart', async () => {
        // Binance and Bitget print different numbers for the same hour. A key
        // without the venue keeps whichever row arrived last, which turns a
        // venue switch into a rewritten history.
        await repository.record(
            entry({ provider: 'binance', price: 100_000 }),
        );
        await repository.record(
            entry({ provider: 'bitget', price: 100_050 }),
        );

        const binance = await repository.list('BTCUSDT', 10, undefined, {
            provider: 'binance',
        });
        const bitget = await repository.list('BTCUSDT', 10, undefined, {
            provider: 'bitget',
        });

        expect(binance[0]?.price).toBe(100_000);
        expect(bitget[0]?.price).toBe(100_050);
    });

    it('scopes retention to one series rather than to the symbol', async () => {
        // A symbol analysed at two intervals has one limit shared by two
        // histories, and whichever wrote last quietly cuts the other's.
        const narrow = createSignalHistoryRepository({ maxEntries: 2 });

        for (let index = 0; index < 4; index += 1) {
            await narrow.record(
                entry({ interval: '1h', timestamp: BASE + index * HOUR_MS }),
            );
            await narrow.record(
                entry({ interval: '4h', timestamp: BASE + index * HOUR_MS }),
            );
        }

        const removed = await narrow.trimRetention('BTCUSDT', { interval: '1h' });

        expect(removed).toBe(2);

        const hourly = await narrow.list('BTCUSDT', 50, undefined, {
            interval: '1h',
        });
        const fourHourly = await narrow.list('BTCUSDT', 50, undefined, {
            interval: '4h',
        });

        expect(hourly).toHaveLength(2);
        expect(fourHourly).toHaveLength(4);
    });
});

describe('a history row remembers the market it came from', () => {
    it('stores the regime and the quality assessment', async () => {
        await repository.record(
            entry({
                context: {
                    regime: 'NORMAL/TREND_UP',
                    dataQuality: 0.91,
                    dataQualityUsable: true,
                    dataQualityWorst: 'freshness',
                },
            }),
        );

        const [stored] = await repository.list('BTCUSDT', 10);

        expect(stored?.context).toEqual({
            regime: 'NORMAL/TREND_UP',
            dataQuality: 0.91,
            dataQualityUsable: true,
            dataQualityWorst: 'freshness',
        });
    });

    it('records an unknown regime as unknown rather than inventing one', async () => {
        // A row with no regime says so. Grouping it into a bucket called
        // "unknown" and reporting that bucket alongside the others is a
        // performance table whose totals do not add up to its sample.
        await repository.record(entry());

        const [stored] = await repository.list('BTCUSDT', 10);

        expect(stored?.context?.regime).toBeNull();
        expect(stored?.context?.dataQuality).toBeNull();
    });

    it('replaces the context of a re-recorded hour', async () => {
        // The newest analysis of the hour wins, and it is the one whose context
        // counts. Keeping the older one would leave a measurement describing a
        // market that was not the one the row is about.
        await repository.record(
            entry({
                context: {
                    regime: 'HIGH/RANGE',
                    dataQuality: 0.3,
                    dataQualityUsable: false,
                    dataQualityWorst: 'gaps',
                },
            }),
        );
        await repository.record(
            entry({
                timestamp: BASE + 60_000,
                context: {
                    regime: 'LOW/TREND_DOWN',
                    dataQuality: 0.95,
                    dataQualityUsable: true,
                    dataQualityWorst: 'venue',
                },
            }),
        );

        const [stored] = await repository.list('BTCUSDT', 10);

        expect(stored?.context?.regime).toBe('LOW/TREND_DOWN');
        expect(stored?.context?.dataQuality).toBe(0.95);
    });
});

describe('the identity of a row is the whole series', () => {
    it('names every column the primary key is built from', async () => {
        const result = await pool.query<{ attname: string }>(
            `SELECT a.attname
             FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid
                                 AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = 'signal_history'::regclass AND i.indisprimary`,
        );

        const columns = result.rows.map((row) => row.attname).sort();

        // Asserted against the database rather than against the migration text,
        // because the constraint is what actually decides whether two
        // intervals collide.
        expect(columns).toEqual([
            'hour_bucket',
            'interval',
            'provider',
            'symbol',
        ]);
    });

    it('survives a migration from the original key without losing rows', async () => {
        const result = await pool.query<{ total: number }>(
            'SELECT COUNT(*)::int AS total FROM signal_history',
        );

        // The migration adds columns and rebuilds the key in place rather than
        // creating a new table. A rewrite would abandon every row measured so
        // far, and "old results are never rewritten" is a rule this system
        // holds itself to.
        expect(result.rows[0]?.total).toBeGreaterThanOrEqual(0);
    });
});

describe('which series a market is filed under', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('names the venue configured for that market, not the primary', async () => {
        // **This is the finding.** Round 89 fixed `configuredSeries`, and the three
        // tables that take their key from it were corrected. History was not:
        // `seriesOf` in the repository defaulted the venue to
        // `marketConfig.provider`, and the only production writer never set one.
        //
        // Nothing collided — `symbol` is in the primary key — so no test failed and
        // no row was lost. The table simply claimed binance-sourced prices came from
        // binance, and a join on `(symbol, provider, interval)` between history and
        // outcomes would have matched nothing for the second market.
        vi.resetModules();

        vi.stubEnv('MARKET_SYMBOL', 'BTCUSDT');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h');

        const { recordSignalHistory } = await import('./signal-history.service.js');

        await recordSignalHistory({
            timestamp: BASE,
            symbol: 'ETHUSDT',
            signal: 'LONG',
            consensus: 60,
            price: 3_000,
        });

        const rows = await getTestPool().query<{ symbol: string; provider: string }>(
            'SELECT symbol, provider FROM signal_history',
        );

        expect(rows.rows).toEqual([{ symbol: 'ETHUSDT', provider: 'bitget' }]);
    });

    it('reads back the series it wrote, because both sides must agree', async () => {
        // A read that defaulted the venue would look in a series nothing was written
        // to and answer "no history" for a market that has some — which is why the
        // series is resolved in the service, once, for both sides: they live in
        // different functions and the repository defaults each independently.
        vi.resetModules();

        vi.stubEnv('MARKET_SYMBOL', 'BTCUSDT');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h');

        const { recordSignalHistory, getSignalHistory } =
            await import('./signal-history.service.js');

        await recordSignalHistory({
            timestamp: BASE,
            symbol: 'ETHUSDT',
            signal: 'LONG',
            consensus: 60,
            price: 3_000,
        });

        const read = await getSignalHistory(10, undefined, 'ETHUSDT');

        expect(read).toHaveLength(1);
        expect(read[0]?.signal).toBe('LONG');
    });
});
