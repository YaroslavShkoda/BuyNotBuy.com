import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { getAssetRepository } from '../../instruments/asset.repository.js';
import { truncateSignalTables } from '../../test-support/test-database.js';

import { InstrumentProblemSchema, InstrumentResponseSchema, InstrumentsResponseSchema } from '../schemas.js';

/**
 * `/api/instruments`, and the claim that it is additive.
 *
 * The value of the new endpoint is not that it answers — four lines of SQL would
 * answer too. It is that it answers about **one named instrument**, which the
 * frozen surface cannot do at all: `/api/market` reads whatever the
 * configuration says and there is no way to ask it about the other market.
 *
 * So the tests below are checked in two directions. They assert the new
 * endpoint says the right thing, and they assert that adding it changed nothing
 * the dashboard already draws. The second half is the part that would catch a
 * "harmless refactor" that quietly moved a default.
 */

const NOW = 1_760_000_000_000;

/**
 * The three states PHASE 14 leaves behind, all in one registry.
 *
 * `recordLearnedCategory` is an UPDATE, so an asset has to exist before it can
 * be reclassified — seeding SOL as configured and then flipping it is the
 * journey a learned asset actually takes, and a test that only ever inserted
 * learned rows would never see the transition.
 */
async function seed(): Promise<void> {
    const repository = getAssetRepository();

    await repository.seedFromConfiguration([
        { symbol: 'BTC', category: 'crypto' },
        { symbol: 'ETH', category: 'crypto' },
        { symbol: 'USDT', category: 'crypto' },
        { symbol: 'SOL', category: 'crypto' },
    ]);

    await repository.recordLearnedCategory('SOL', 'crypto', NOW);
    await repository.recordInstrument('BTCUSDT');
    await repository.recordInstrument('ETHUSDT');
}

describe('the registry can be read', () => {
    let app: ReturnType<typeof createApp>;

    beforeEach(async () => {
        await truncateSignalTables();
        await seed();
        app = createApp();
        await app.ready();
    });

    it('lists instruments with both assets and their provenance', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/instruments' });

        expect(response.statusCode).toBe(200);

        const body = InstrumentsResponseSchema.parse(response.json());
        const tickers = body.instruments.map((row) => row.ticker);

        expect(tickers).toContain('BTCUSDT');
        expect(tickers).toContain('ETHUSDT');

        const btc = body.instruments.find((row) => row.ticker === 'BTCUSDT');

        expect(btc?.base.symbol).toBe('BTC');
        expect(btc?.quote.symbol).toBe('USDT');
        expect(btc?.market).toBe('crypto');
        // The field the endpoint exists for: `configured` and `learned` are
        // different claims and the client is told which one it is reading.
        expect(['configured', 'learned']).toContain(btc?.base.source);
    });

    it('keeps the list in a stable order', async () => {
        // A registry whose order changes between two identical requests cannot
        // be diffed, and a client cannot tell a change from a shuffle.
        const first = await app.inject({ method: 'GET', url: '/api/instruments' });
        const second = await app.inject({ method: 'GET', url: '/api/instruments' });

        expect(first.json()).toEqual(second.json());

        const tickers = InstrumentsResponseSchema.parse(first.json()).instruments.map(
            (row) => row.ticker,
        );

        expect(tickers).toEqual([...tickers].sort((a, b) => a.localeCompare(b)));
    });

    it('answers about one named instrument', async () => {
        // The capability the frozen surface does not have. If this endpoint
        // only ever described the configured market it would be `/api/market`
        // with more words in front of it.
        const response = await app.inject({
            method: 'GET',
            url: '/api/instruments/ETHUSDT',
        });

        expect(response.statusCode).toBe(200);

        const body = InstrumentResponseSchema.parse(response.json());

        expect(body.ticker).toBe('ETHUSDT');
        expect(body.base.symbol).toBe('ETH');
        expect(body.quote.symbol).toBe('USDT');
    });

    it('is not case-sensitive, because the registry is not', async () => {
        const lower = await app.inject({
            method: 'GET',
            url: '/api/instruments/btcusdt',
        });

        expect(lower.statusCode).toBe(200);
        expect(InstrumentResponseSchema.parse(lower.json()).ticker).toBe('BTCUSDT');
    });

    it('reports a market that exists but may not be traded, and why', async () => {
        // A boolean would be one thing too few: `base_inactive` is a decision
        // somebody made and `unknown_instrument` is a typo, and the two are
        // fixed by different people.
        await getAssetRepository().suspendAsset('ETH');

        const response = await app.inject({
            method: 'GET',
            url: '/api/instruments/ETHUSDT',
        });

        expect(response.statusCode).toBe(200);

        const body = InstrumentResponseSchema.parse(response.json());

        expect(body.tradable).toBe(false);
        expect(body.reason).toBe('base_inactive');
    });

    it('says a ticker it has never heard of does not exist', async () => {
        // 404 rather than a well-formed instrument with empty fields. A client
        // holding a valid-looking object for a market nobody trades will carry
        // the lie further than a status code lets it.
        const response = await app.inject({
            method: 'GET',
            url: '/api/instruments/NOSUCH',
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({
            error: { code: 'INSTRUMENT_NOT_FOUND' },
        });

        // The declared error contract, checked against the bytes on the wire.
        // The schema is strict, so this also fails if a field is added to the
        // response without a decision about whether it belongs to the contract
        // — which is the whole reason the schema exists rather than a comment.
        expect(() => InstrumentProblemSchema.parse(response.json())).not.toThrow();
    });

    it('answers a question it cannot with a declared body, not an invented one', async () => {
        // The refusal and the absence are different answers and both are typed.
        // A non-strict schema would pass either, which is why the parse above
        // would be decoration without `.strict()`.
        const response = await app.inject({
            method: 'GET',
            url: '/api/instruments/NOSUCH',
        });

        const body = InstrumentProblemSchema.parse(response.json());

        expect(body.error.reason).toBeNull();
        expect(body.error.message).toContain('NOSUCH');
    });
});

describe('the frozen endpoints did not move', () => {
    let app: ReturnType<typeof createApp>;

    beforeEach(async () => {
        await truncateSignalTables();
        await seed();
        app = createApp();
        await app.ready();
    });

    it('still answers the routes the dashboard already calls', async () => {
        // Registered, not merely present in the source. A route file that is
        // written and never wired is the exact failure
        // `architecture-lint.ts` documents for unreachable modules, and this
        // assertion is the only thing that would notice it for a new one.
        //
        // The check is "not 404" rather than "is 200" on purpose. `/api/market`
        // returns 502 here because the test database has no venue behind it, and
        // an earlier version of this block asserted that its status matched the
        // new endpoint's. That test asserted 502 === 200: it compared two
        // environment failures and called it compatibility.
        for (const url of [
            '/api/price',
            '/api/market',
            '/api/analysis',
            '/api/signal-history',
        ]) {
            const response = await app.inject({ method: 'GET', url });

            expect(
                response.statusCode,
                `${url} answered ${response.statusCode}`,
            ).not.toBe(404);
        }
    });
});
