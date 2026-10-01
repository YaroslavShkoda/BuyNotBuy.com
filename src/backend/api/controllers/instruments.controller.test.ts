import { beforeEach, describe, expect, it, vi } from 'vitest';

const { querySpy } = vi.hoisted(() => ({ querySpy: vi.fn() }));

vi.mock('../../db/pool.js', () => ({
    query: querySpy,
    withTransaction: vi.fn(),
}));

const { listInstruments } = await import('./instruments.controller.js');

/**
 * The list endpoint, measured rather than asserted about.
 *
 * **The count was 12 for five instruments and is 2 now, and none of the 2373
 * tests noticed either fact.** That was measured, not reasoned: the loop was put
 * back into the controller, the full suite ran, and every test passed. An
 * improvement that nothing can fail when it is undone is a change that has not
 * happened yet.
 *
 * So this counts. Mocking the pool rather than wrapping the driver is the
 * choice: it is deterministic, it costs no real connection, and — the part that
 * matters — it makes the count the *only* way through, so a future refactor
 * cannot quietly add a round trip.
 *
 * **It asserts the answer as well as the count, on purpose.** A test that only
 * checked `querySpy` was called twice would pass against a controller that asks
 * nothing and returns nothing. The rows below have to come back intact, which
 * means the two calls were genuinely made and genuinely used.
 */

const INSTRUMENTS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT'];

const instrumentRow = (ticker: string) => ({
    ticker,
    baseAsset: ticker.slice(0, ticker.length - 4),
    quoteAsset: 'USDT',
    marketKind: 'crypto',
    status: 'active',
});

const assetRow = (symbol: string, status: 'active' | 'inactive' = 'active') => ({
    symbol,
    category: 'crypto',
    status,
    source: 'learned',
    decidedAt: 1_760_000_000_000,
});

/**
 * Answers by what the SQL asks for, not by call order.
 *
 * **This is the detail that makes the controls mean anything.** A mock set up
 * with `mockResolvedValueOnce` runs dry on the third call and throws, so every
 * test fails with an exception about a missing return value — which reads like
 * "the count is wrong" but is really "the mock gave up". Keying the answer on
 * the table being read means an extra query still returns valid rows, and the
 * only thing left to fail is `toHaveBeenCalledTimes`, which is the claim.
 *
 * The `WHERE ticker = $1` filter is honoured for the same reason. A mock that
 * ignores it answers every question about the first row in the table, so
 * `tradability('ETHUSDT')` returns BTCUSDT's verdict — and a test asserting
 * ETHUSDT is tradable would then fail for an artefact of the mock rather than
 * for anything the code did. A control that fails for the wrong reason is worse
 * than no control, because it looks like one that works.
 */
function answerWith(
    instruments: readonly Record<string, unknown>[],
    assets: readonly Record<string, unknown>[],
): void {
    querySpy.mockReset();
    querySpy.mockImplementation(
        async (sql: string, params?: unknown[]) => {
            if (!sql.includes('FROM instrument')) {
                return { rows: assets };
            }

            const ticker =
                sql.includes('WHERE ticker = $1') && Array.isArray(params)
                    ? (params[0] as string | undefined)
                    : undefined;

            return {
                rows:
                    ticker === undefined
                        ? instruments
                        : instruments.filter((row) => row['ticker'] === ticker),
            };
        },
    );
}

const instrumentRows = (tickers: readonly string[]) => tickers.map(instrumentRow);

describe('listing the registry costs two queries, not two per instrument', () => {
    beforeEach(() => {
        answerWith(instrumentRows(INSTRUMENTS), [
            assetRow('BTC'),
            assetRow('ETH'),
            assetRow('SOL'),
            assetRow('XRP'),
            assetRow('ADA'),
            assetRow('USDT'),
        ]);
    });

    it('asks the database twice for five instruments', async () => {
        const rows = await listInstruments();

        // The count is the claim. Two is the floor: one read of the instruments,
        // one of the assets they are made of.
        expect(querySpy).toHaveBeenCalledTimes(2);
        expect(rows).toHaveLength(5);
    });

    it('still returns every instrument with both of its assets', async () => {
        // Without this, "was called twice" would be satisfied by a controller
        // that calls twice and answers nothing.
        //
        // Sorted, because the endpoint sorts. The first version compared against
        // the order the fixtures were written in, which happened to be
        // alphabetical only for `ADAUSDT` — and it failed in the correct
        // configuration for the same reason it failed in the wrong one, which is
        // a test that cannot tell them apart.
        const rows = await listInstruments();

        expect(rows.map((row) => row.ticker)).toEqual([
            ...INSTRUMENTS,
        ].sort((left, right) => left.localeCompare(right)));
        expect(rows[0]).toMatchObject({
            base: { symbol: 'ADA', category: 'crypto' },
            quote: { symbol: 'USDT' },
            tradable: true,
            reason: null,
        });
    });

    it('does not grow with the registry', async () => {
        // The N+1 was not a fixed cost that happened to be large; it grew with
        // every instrument added. Twenty instruments must still cost two.
        const many = Array.from({ length: 20 }, (_, index) => `A${index}USDT`);
        answerWith(instrumentRows(many), [
            ...many.map((ticker) => assetRow(ticker.slice(0, ticker.length - 4))),
            assetRow('USDT'),
        ]);

        const rows = await listInstruments();

        expect(rows).toHaveLength(20);
        expect(querySpy).toHaveBeenCalledTimes(2);
    });

    it('reports a suspended asset without asking about it again', async () => {
        // The reason is a fact about rows already in hand. Reading it back per
        // instrument is what made the old shape two queries rather than one.
        answerWith(instrumentRows(['BTCUSDT', 'ETHUSDT']), [
            assetRow('BTC', 'inactive'),
            assetRow('ETH'),
            assetRow('USDT'),
        ]);

        const rows = await listInstruments();

        expect(rows.find((row) => row.ticker === 'BTCUSDT')).toMatchObject({
            tradable: false,
            reason: 'base_inactive',
        });
        expect(rows.find((row) => row.ticker === 'ETHUSDT')).toMatchObject({
            tradable: true,
        });
        expect(querySpy).toHaveBeenCalledTimes(2);
    });
});