import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import type { MarketRequest } from '../market/capability.js';

/**
 * What the market is a parameter for.
 *
 * **`runBacktest` had no test at all when this file was written** — the 164
 * tests in this directory cover the pure arithmetic (walk-forward, optimiser,
 * metrics, statistics) and none of them call the function that fetches candles
 * and builds the report. I changed that function to take a market, and the
 * green run said nothing about the change, because a green run says nothing
 * about code nothing calls.
 *
 * Everything below stubs the network and the clock. What is being checked is
 * which question gets asked and of whom, not what the arithmetic does.
 */

const mocks = vi.hoisted(() => ({
    getMarketData: vi.fn(),
    marketProviderFor: vi.fn(),
    runWalkForward: vi.fn(),
    manifestFor: vi.fn((..._args: unknown[]) => ({ experiment: 'stub' })),
    currentRegistry: {
        observe: vi.fn(),
    },
}));

vi.mock('../market/market.service.js', () => ({
    getMarketData: mocks.getMarketData,
    resolveRequest: (request?: MarketRequest) =>
        request ?? { instrument: 'BTCUSDT', interval: '1h' },
}));

vi.mock('../market/market.provider.js', () => ({
    marketProviderFor: mocks.marketProviderFor,
}));

vi.mock('./walk-forward.js', () => ({
    runWalkForward: mocks.runWalkForward,
    DEFAULT_WALK_FORWARD_OPTIONS: {
        trainingBars: 100,
        foldBars: 50,
        maxFolds: 2,
        stepBars: 10,
    },
}));

vi.mock('./manifest.js', () => ({
    manifestFor: mocks.manifestFor,
}));

vi.mock('../observability/registry.js', () => ({
    currentRegistry: () => mocks.currentRegistry,
}));

vi.mock('../market/candle-validation.js', () => ({
    assertCandleSeries: vi.fn(),
}));

// The per-asset thresholds resolve through the real configuration, because the
// thing being checked is that the report names the numbers its own market was
// given. Mocking the resolver would make the assertion circular.
vi.mock('../config/indicator.config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../config/indicator.config.js')>();

    return {
        ...actual,
        signalConfigFor: (instrument: string) =>
            instrument === 'ETHUSDT'
                ? {
                      stochastic: { longThreshold: 22, shortThreshold: 74, center: 50 },
                      ema: { confirmBars: 3, convictionScalePercent: 2 },
                      momentum: { deadbandPercent: 0.15, convictionScalePercent: 3 },
                  }
                : actual.INDICATOR_SIGNAL_CONFIG,
    };
});

const { runBacktest } = await import('./backtest.service.js');

/** Bars that pass every shape check, because the checks are stubbed anyway. */
const candles = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({
        timestamp: 1_000_000 + index * 3_600_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
    }));

beforeEach(() => {
    vi.clearAllMocks();

    mocks.getMarketData.mockResolvedValue({
        data: { price: { price: 100 } },
        stale: false,
        ageMs: 0,
    });
    mocks.marketProviderFor.mockReturnValue({
        getHistoricalCandles: vi.fn(async () => candles(400)),
    });
    mocks.runWalkForward.mockReturnValue({ score: 0.5, folds: [] });
});

describe('which market a backtest measures', () => {
    it('asks the router about the market it was told to measure', async () => {
        // Before the parameter existed this fetched through the module
        // singleton, so a backtest could not have reached a market the live
        // path could not — even after the router learned to serve several.
        const report = await runBacktest({}, { instrument: 'ETHUSDT', interval: '1h' });

        expect(mocks.marketProviderFor).toHaveBeenCalledWith('ETHUSDT');
        expect(report.symbol).toBe('ETHUSDT');
    });

    it('names the report after what it measured, not after the configuration', async () => {
        // A symbol read from the configuration always agrees with the data,
        // because it is the same value the data was chosen by. That agreement
        // is why the old defect produced no symptom anywhere.
        const report = await runBacktest({}, { instrument: 'SOLUSDT', interval: '4h' });

        expect(report.symbol).toBe('SOLUSDT');
        expect(report.candleInterval).toBe('4h');
    });

    it('refuses a market the router will not serve, rather than measuring another', async () => {
        // The router's refusal is a sentence with a reason. Swallowing it and
        // falling back to the configured market is the exact failure this
        // parameter was added to remove, so the refusal has to travel.
        mocks.marketProviderFor.mockImplementation(() => {
            throw new Error('instrument_not_served: SOLUSDT');
        });

        await expect(runBacktest({}, { instrument: 'SOLUSDT', interval: '1h' })).rejects.toThrow(
            /instrument_not_served/,
        );
        expect(mocks.runWalkForward).not.toHaveBeenCalled();
    });

    it('does not consult the configuration when a market is named', async () => {
        await runBacktest({}, { instrument: 'ETHUSDT', interval: '1h' });

        const asked = mocks.getMarketData.mock.calls[0]?.[0];

        expect(asked).toEqual({ instrument: 'ETHUSDT', interval: '1h' });
    });

    it('defaults to the configured market when told none, so every caller still works', async () => {
        const report = await runBacktest();

        expect(mocks.marketProviderFor).toHaveBeenCalledWith('BTCUSDT');
        expect(report.symbol).toBe('BTCUSDT');
    });

    it('reports the thresholds its own market was configured with', async () => {
        // `shippedParameters` is the record of what actually went into the run.
        // While it read the global configuration, a per-asset override could
        // exist, be used, and be reported as though it had not been — and the
        // manifest beside it would contradict the report printed next to it.
        const report = await runBacktest({}, { instrument: 'ETHUSDT', interval: '1h' });

        expect(report.shippedParameters).toEqual({
            longThreshold: 22,
            shortThreshold: 74,
        });
    });

    it('reports the shipped thresholds for a market with no override', async () => {
        const report = await runBacktest({}, { instrument: 'SOLUSDT', interval: '1h' });

        expect(report.shippedParameters).toEqual({
            longThreshold: 15,
            shortThreshold: 80,
        });
    });

    it('puts the market into the manifest, so a result says what it was about', async () => {
        await runBacktest({}, { instrument: 'ETHUSDT', interval: '1h' });

        // The manifest is the record that makes a result reproducible. A record
        // whose symbol is a config value says only that the config was read.
        //
        // Index 4, not 3: my first version read the experiment block — the one
        // carrying `ETHUSDT-1h-400` — and failed against an object that looked
        // like it matched. The number of omitted properties in the message was
        // the clue I did not read: the id already had the right market in it.
        const series = mocks.manifestFor.mock.calls[0]?.[4] as
            | { symbol: string; interval: string }
            | undefined;

        expect(series).toMatchObject({ symbol: 'ETHUSDT', interval: '1h' });
    });
});

describe('properties', () => {
    const instrument = fc.stringMatching(/^[A-Z]{3,10}USDT$/);
    const interval = fc.constantFrom('1m', '5m', '1h', '4h', '1d');

    // The work is async and `fast-check` wants a synchronous answer, so the
    // samples are drawn first and the runs happen outside the property. My
    // first version returned a promise from the predicate, which is not a
    // boolean and fails on the first sample rather than on a real counterexample.
    it('never labels a run with a market other than the one it measured', async () => {
        for (const [name, tf] of fc.sample(fc.tuple(instrument, interval), 40)) {
            const report = await runBacktest({}, { instrument: name, interval: tf });

            expect(report.symbol).toBe(name);
            expect(report.candleInterval).toBe(tf);
        }
    });

    it('always routes through the market it was asked about, and nowhere else', async () => {
        for (const name of fc.sample(instrument, 40)) {
            vi.clearAllMocks();
            mocks.getMarketData.mockResolvedValue({
                data: { price: { price: 100 } },
                stale: false,
                ageMs: 0,
            });
            mocks.marketProviderFor.mockReturnValue({
                getHistoricalCandles: vi.fn(async () => candles(400)),
            });
            mocks.runWalkForward.mockReturnValue({ score: 0.5, folds: [] });

            await runBacktest({}, { instrument: name, interval: '1h' });

            expect(mocks.marketProviderFor.mock.calls.length).toBeGreaterThan(0);

            for (const call of mocks.marketProviderFor.mock.calls) {
                expect(call[0]).toBe(name);
            }
        }
    });
});
