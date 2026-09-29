import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
    describeRoute,
    route,
    serves,
    type MarketRequest,
    type VenueCapability,
} from './capability.js';

const binance: VenueCapability = {
    venue: 'binance',
    instruments: ['BTCUSDT', 'ETHUSDT'],
    intervals: ['1m', '1h', '1d'],
};

const bitget: VenueCapability = {
    venue: 'bitget',
    instruments: ['SOLUSDT', 'BTCUSDT'],
    intervals: ['1h', '4h'],
};

const ask = (instrument: string, interval = '1h'): MarketRequest => ({ instrument, interval });

/** The refusal, or a failure the test itself caused. */
function refused(result: ReturnType<typeof route>): Extract<ReturnType<typeof route>, { ok: false }> {
    if (result.ok) {
        throw new Error(`expected a refusal, got venue ${result.venue}`);
    }

    return result;
}

describe('what a venue says it can serve', () => {
    it('serves a market it lists, at an interval it lists', () => {
        expect(serves(binance, ask('BTCUSDT'))).toBe(true);
    });

    it('does not serve a market it does not list, even at an interval it lists', () => {
        expect(serves(binance, ask('SOLUSDT'))).toBe(false);
    });

    it('does not serve a listed market at an unlisted interval', () => {
        expect(serves(binance, ask('BTCUSDT', '4h'))).toBe(false);
    });

    it('compares tickers without caring about case or padding', () => {
        // A venue that lists `btcusdt` and a request for ` BTCUSDT ` are the
        // same market. Getting this wrong produces a refusal naming a market
        // that is on the list in front of the reader.
        expect(serves({ ...binance, instruments: ['btcusdt'] }, ask(' BTCUSDT '))).toBe(true);
    });
});

describe('choosing a venue', () => {
    it('takes the first venue in the order that serves it', () => {
        const found = route(ask('BTCUSDT'), [bitget, binance], ['binance', 'bitget']);

        expect(found).toEqual({ ok: true, venue: 'binance' });
    });

    it('falls through to a later venue when the first does not serve it', () => {
        const found = route(ask('SOLUSDT'), [bitget, binance], ['binance', 'bitget']);

        expect(found).toEqual({ ok: true, venue: 'bitget' });
    });

    it('follows the order, not the declaration order', () => {
        // Same two venues, opposite preference, opposite answer. A router that
        // consulted the capabilities array would make the order decorative.
        const found = route(ask('BTCUSDT'), [bitget, binance], ['bitget', 'binance']);

        expect(found).toEqual({ ok: true, venue: 'bitget' });
    });

    it('refuses rather than falling back to the first venue', () => {
        // The failure this whole phase exists to prevent: answering a request
        // for EUR with BTC candles because a venue was available.
        const found = route(ask('EURUSD'), [binance, bitget], ['binance', 'bitget']);

        expect(found.ok).toBe(false);
    });

    it('does not consult a venue that was not offered, however capable it is', () => {
        // Only `bitget` is on offer and only `bitget` can serve SOLUSDT, so
        // routing to it is correct — the refusal that proves the point needs a
        // market the *offered* venue cannot serve and the capable one was
        // never named. An earlier version of this test asked for BTCUSDT and
        // asserted a refusal, and it was wrong: bitget does serve BTCUSDT.
        expect(route(ask('SOLUSDT'), [bitget], ['binance']).ok).toBe(false);
    });

    it('ignores a name in the order that no capability describes', () => {
        // A configured venue with no declared capability is a deployment that
        // has not finished being written down, and answering from it would be
        // guessing.
        const found = route(ask('BTCUSDT'), [binance], ['kraken', 'binance']);

        expect(found).toEqual({ ok: true, venue: 'binance' });
    });
});

describe('the difference between the two refusals', () => {
    it('says the instrument is not served when no venue lists it', () => {
        expect(refused(route(ask('EURUSD'), [binance, bitget], ['binance', 'bitget'])).reason).toBe(
            'instrument_not_served',
        );
    });

    it('says the interval is not served when the market is listed elsewhere', () => {
        // Conflating these produces "unknown market 4h", which reads as a typo
        // in the interval when the real problem is a resolution this venue
        // does not publish.
        expect(refused(route(ask('BTCUSDT', '4h'), [binance, bitget], ['binance'])).reason).toBe(
            'interval_not_served',
        );
    });

    it('names the venues asked and what they do serve', () => {
        const found = refused(route(ask('EURUSD'), [binance, bitget], ['binance', 'bitget']));

        expect(found.asked).toEqual(['binance', 'bitget']);
        expect(found.served).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    });

    it('reports an empty configuration as its own thing', () => {
        // "Unknown market" when nothing is configured is a message about the
        // market, sent about a problem that is entirely in the configuration.
        expect(refused(route(ask('BTCUSDT'), [binance], [])).reason).toBe('no_venues_configured');
    });

    it('does not list venues it did not ask', () => {
        expect(refused(route(ask('EURUSD'), [binance, bitget], ['binance'])).asked).toEqual([
            'binance',
        ]);
    });
});

describe('saying the refusal out loud', () => {
    it('names the market, the interval and what is on offer', () => {
        const request = ask('EURUSD', '1h');
        const message = describeRoute(refused(route(request, [binance], ['binance'])), request);

        expect(message).toContain('EURUSD');
        expect(message).toContain('binance');
        expect(message).toContain('BTCUSDT');
    });

    it('does not blame the interval when the market is the problem', () => {
        const request = ask('EURUSD', '1h');
        const message = describeRoute(refused(route(request, [binance], ['binance'])), request);

        expect(message).toContain('does not serve EURUSD');
        expect(message).not.toContain('but not at');
    });

    it('blames the interval when that is the problem', () => {
        const request = ask('BTCUSDT', '4h');
        const message = describeRoute(refused(route(request, [binance], ['binance'])), request);

        expect(message).toContain('serves BTCUSDT but not at 4h');
    });

    it('reports an empty configuration as its own sentence', () => {
        const request = ask('BTCUSDT');
        const message = describeRoute(refused(route(request, [binance], [])), request);

        expect(message).toContain('No market venue is configured');
    });
});

describe('properties', () => {
    const capability = fc
        .uniqueArray(fc.constantFrom('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BTCBRL'), {
            minLength: 1,
            maxLength: 4,
        })
        .map((instruments) => ({
            venue: 'v1',
            instruments,
            intervals: ['1m', '1h', '1d'],
        }));

    it('never returns a venue that does not serve the request', () => {
        // The one thing a router must never do, stated as a property so it
        // holds for capability tables nobody has thought to enumerate.
        fc.assert(
            fc.property(
                fc.array(capability, { minLength: 1, maxLength: 5 }),
                fc.uniqueArray(fc.constantFrom('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT'), {
                    minLength: 1,
                    maxLength: 5,
                }),
                fc.constantFrom('1m', '1h', '1d', '4h'),
                (capabilities, venues, interval) => {
                    const request: MarketRequest = { instrument: venues[0] as string, interval };
                    const found = route(request, capabilities, venues);

                    if (!found.ok) {
                        return true;
                    }

                    const chosen = capabilities.find((entry) => entry.venue === found.venue);

                    return chosen !== undefined && serves(chosen, request);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('refuses every market when nothing is configured', () => {
        fc.assert(
            fc.property(
                fc.uniqueArray(fc.constantFrom('BTCUSDT', 'ETHUSDT'), { minLength: 1, maxLength: 2 }),
                fc.constantFrom('1h', '1d'),
                (instruments, interval) => {
                    const found = route({ instrument: instruments[0] as string, interval }, [], []);

                    return found.ok === false;
                },
            ),
            { numRuns: 50 },
        );
    });

    it('always explains itself, whatever it decided', () => {
        fc.assert(
            fc.property(fc.constantFrom('BTCUSDT', 'ETHUSDT', 'ZZZUSD'), fc.constantFrom('1h', '3d'), (instrument, interval) => {
                const request: MarketRequest = { instrument, interval };
                const found = route(request, [binance, bitget], ['binance', 'bitget']);

                if (found.ok) {
                    return true;
                }

                const message = describeRoute(found, request);

                return message.length > 20 && message.includes(instrument);
            }),
            { numRuns: 100 },
        );
    });
});
