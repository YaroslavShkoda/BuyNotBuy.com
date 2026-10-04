import { afterEach, describe, expect, it } from 'vitest';

import { marketUrl } from './market';
import { analysisUrl } from './analysis';
import { signalHistoryUrl } from './history';

const BACKEND = 'http://backend.test';

describe('backend url builders', () => {
    const original = process.env.BACKEND_URL;

    afterEach(() => {
        if (original === undefined) {
            delete process.env.BACKEND_URL;
        } else {
            process.env.BACKEND_URL = original;
        }
    });

    it('market: the frozen route with no instrument, the additive one with it', () => {
        process.env.BACKEND_URL = BACKEND;

        expect(marketUrl()).toBe(`${BACKEND}/api/market`);
        expect(marketUrl('BTCUSDT')).toBe(`${BACKEND}/api/instruments/BTCUSDT/market`);
    });

    it('analysis: the frozen route with no instrument, the additive one with it', () => {
        process.env.BACKEND_URL = BACKEND;

        expect(analysisUrl()).toBe(`${BACKEND}/api/analysis`);
        expect(analysisUrl('ETHUSDT')).toBe(`${BACKEND}/api/instruments/ETHUSDT/analysis`);
    });

    it('history: the limit is always set, the instrument rides as a query parameter', () => {
        process.env.BACKEND_URL = BACKEND;

        expect(signalHistoryUrl()).toBe(`${BACKEND}/api/signal-history?limit=24`);
        expect(signalHistoryUrl('BTCUSDT')).toBe(
            `${BACKEND}/api/signal-history?limit=24&instrument=BTCUSDT`,
        );
    });

    it('encodes the instrument so a crafted ticker cannot change the path', () => {
        process.env.BACKEND_URL = BACKEND;

        expect(marketUrl('../other')).toBe(
            `${BACKEND}/api/instruments/..%2Fother/market`,
        );
        expect(signalHistoryUrl('A&B')).toBe(
            `${BACKEND}/api/signal-history?limit=24&instrument=A%26B`,
        );
    });
});
