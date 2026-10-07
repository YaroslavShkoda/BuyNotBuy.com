import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The wiring, not the library.
 *
 * `signals/asset-thresholds.test.ts` proves `calculateSignal` honours a
 * configuration it is handed. It does not prove the live pipeline hands it one,
 * and that is the whole defect: `analyzeMarket` called `calculateSignal` with
 * the fifth argument omitted and `resolveActive()` fingerprinted the global
 * defaults, so a configured `ETHUSDT` override changed the backtest and nothing
 * else. A control proved the gap — deleting the one line that passes
 * `signalConfig` left that test green.
 *
 * So these cases go through `analyzeMarket` with the market layer stubbed, and
 * read what was **filed**: the strategy version the snapshot carries. A version
 * whose stored thresholds are the shipped ones while the market was configured
 * with its own is the observable form of the defect, and it does not depend on
 * which direction the signal came out.
 *
 * The fixture adds one market-specific setting to a test copy of the selected
 * profile. Production configuration stays code-backed and does not use an
 * environment string parser for strategy policy.
 */

vi.mock('../config/strategy.profile.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../config/strategy.profile.js')>();

    return {
        ...actual,
        strategyProfile: {
            ...actual.strategyProfile,
            indicators: {
                ...actual.strategyProfile.indicators,
                assetSignalOverrides: {
                    ETHUSDT: { stochastic: { longThreshold: 22 } },
                },
            },
        },
    };
});

const { analyzeMarket } = await import('./analysis.service.js');
const marketService = await import('../market/market.service.js');
const signalService = await import('../signals/signal.service.js');
const { marketData, marketDataResult } = await import('../test-support/market-data.js');
const { query } = await import('../db/pool.js');
const { fingerprintStrategy } = await import('../config/strategy-fingerprint.js');
const { signalConfigFor } = await import('../config/indicator.config.js');

/**
 * Captured before any spy is installed: `vi.spyOn` replaces the property, so a
 * mock that delegated to `signalService.calculateSignal` would be calling itself.
 */
const signalUnderTest = signalService.calculateSignal;

/**
 * The configuration argument, typed as what it is.
 *
 * The first version collected it as `unknown[] | undefined` and cast at the
 * assertion, which is two places to be wrong and one that the compiler refuses.
 * Naming the type at the point of capture says what is being watched — that the
 * fourth argument is the market's thresholds and not an absent one.
 */
type CapturedConfig = ReturnType<typeof signalConfigFor>;

function captureArguments(): CapturedConfig[] {
    const seen: CapturedConfig[] = [];

    vi.spyOn(signalService, 'calculateSignal').mockImplementation(
        (...args: Parameters<typeof signalService.calculateSignal>) => {
            seen.push(args[3] as CapturedConfig | undefined as CapturedConfig);

            return signalUnderTest(...args);
        },
    );

    return seen;
}

type Mock = ReturnType<typeof vi.spyOn>;

/** Enough bars for the warm-up, and a series flat enough to change no verdict. */
const candles = Array.from({ length: 900 }, (_, index) => ({
    timestamp: index,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
}));

function serving(symbol: string): Mock {
    return vi.spyOn(marketService, 'getMarketData').mockResolvedValue(
        marketDataResult(
            marketData(candles, { price: { symbol, price: 100 }, provider: 'binance' }),
        ),
    ) as Mock;
}

const logger = { info: () => ({}) } as never;

/** The version a snapshot for this market was filed under, once its write lands. */
async function filedVersionId(symbol: string): Promise<number> {
    return vi.waitFor(async () => {
        const rows = await query<{ id: number }>(
            `SELECT DISTINCT sv.id FROM signal_snapshot s
               JOIN strategy_version sv ON sv.id = s.strategy_version_id
              WHERE s.symbol = $1`,
            [symbol],
        );

        expect(rows.rows[0], `no snapshot filed for ${symbol}`).toBeDefined();

        return rows.rows[0]!.id;
    });
}


/**
 * The thresholds that decided the stored reading, read back rather than
 * assumed.
 *
 * Asserting on the strategy version was not enough, and a control showed it: with
 * `signalConfig` removed from the live `calculateSignal` call every version
 * assertion still passed, because the version comes from `resolveActive` and
 * the signal comes from the computation. Two paths, one market, and a snapshot
 * could be measured under the shipped thresholds and filed under the override's.
 *
 * So the reading itself is checked, and against the rule rather than against an
 * expected value: whatever stochastic ended up stored, the signal filed beside
 * it must be the one the *market's* thresholds produce. Computing the expected
 * answer from the same two functions would only restate the implementation, so
 * the rule is written out here — `value < long` is LONG, `value > short` is
 * SHORT, otherwise NEUTRAL.
 */
interface StoredReading {
    stochastic: number;
    signal: string;
}

async function storedStochastic(symbol: string): Promise<StoredReading> {
    const id = await filedVersionId(symbol);

    return vi.waitFor(async () => {
        const rows = await query<{
            snapshot: {
                indicators: { stochastic: number };
                signal: { indicators: { key: string; signal: string }[] };
            };
        }>(
            `SELECT snapshot FROM signal_snapshot WHERE symbol = $1
               AND strategy_version_id = $2 LIMIT 1`,
            [symbol, id],
        );

        // The wire shape, read off `MarketAnalysis`: `indicators` is the flat
        // published one and the per-indicator readings live under
        // `signal.indicators`. An earlier version of this helper assumed the
        // readings were the array, which is what a first reading of the type
        // suggests and is not what the type says.
        const snapshot = rows.rows[0]?.snapshot;
        const entry = snapshot?.signal.indicators.find(
            (one) => one.key === 'stochastic',
        );

        expect(entry, `no stochastic reading stored for ${symbol}`).toBeDefined();

        return {
            stochastic: snapshot?.indicators.stochastic ?? Number.NaN,
            signal: entry?.signal ?? '',
        };
    });
}

/** The signal the oscillator rule gives for a reading, thresholds named. */
function verdict(stochastic: number, long: number, short: number): string {
    if (stochastic < long) return 'LONG';
    if (stochastic > short) return 'SHORT';

    return 'NEUTRAL';
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('a market configured with its own thresholds', () => {
    it('is measured and filed under those thresholds', async () => {
        serving('ETHUSDT');

        await analyzeMarket(logger, 'req-eth-override');

        // By the id the snapshot ended up under, not by joining on the market:
        // the snapshot write is fire-and-forget by design, so the first read of
        // it races the write. `filedVersionId` is the one place that waits.
        const filed = await filedVersionId('ETHUSDT');

        const stored = await query<{ config: { thresholds: { stochasticLong: number } } }>(
            `SELECT config FROM strategy_version WHERE id = $1`,
            [filed],
        );

        expect(stored.rows[0]?.config.thresholds.stochasticLong).toBe(22);
    });

    it('does not share a version with a market on the shipped configuration', async () => {
        serving('ETHUSDT');

        await analyzeMarket(logger, 'req-eth-override-2');

        const filed = await filedVersionId('ETHUSDT');

        const shipped = await query<{ id: number }>(
            `SELECT id FROM strategy_version WHERE config_hash = $1`,
            [fingerprintStrategy('BTCUSDT').hash],
        );

        expect(filed).not.toBe(shipped.rows[0]?.id);
    });
});

describe('a market nobody configured', () => {
    it('is filed under the shipped configuration, hash unchanged', async () => {
        serving('BTCUSDT');

        await analyzeMarket(logger, 'req-btc-shipped');

        const filed = await filedVersionId('BTCUSDT');

        const shipped = await query<{ id: number }>(
            `SELECT id FROM strategy_version WHERE config_hash = $1`,
            [fingerprintStrategy('BTCUSDT').hash],
        );

        // Adding a second market must not re-version the first: every snapshot
        // stored before the override existed keeps pointing at the version it was
        // taken under, which is what makes the additive migration possible.
        expect(filed).toBe(shipped.rows[0]?.id);
        expect(signalConfigFor('BTCUSDT')).toEqual(signalConfigFor('XRPUSDT'));
    });
});

describe('the thresholds that decided the stored reading are the market own', () => {
    it('reads the override in the snapshot of a configured market', async () => {
        serving('ETHUSDT');

        await analyzeMarket(logger, 'req-eth-thresholds');

        const stored = await storedStochastic('ETHUSDT');
        const override = signalConfigFor('ETHUSDT');

        expect(stored.signal).toBe(
            verdict(
                stored.stochastic,
                override.stochastic.longThreshold,
                override.stochastic.shortThreshold,
            ),
        );

        // And not the shipped answer, for a reading the two disagree on. If the
        // two happen to agree on this series the assertion is vacuous, so it says
        // so rather than passing quietly.
        const shipped = signalConfigFor('BTCUSDT');

        if (
            verdict(stored.stochastic, shipped.stochastic.longThreshold, shipped.stochastic.shortThreshold) !==
            stored.signal
        ) {
            expect(stored.signal).not.toBe(
                verdict(
                    stored.stochastic,
                    shipped.stochastic.longThreshold,
                    shipped.stochastic.shortThreshold,
                ),
            );
        }
    });

    it('reads the shipped pair for a market nobody configured', async () => {
        serving('BTCUSDT');

        await analyzeMarket(logger, 'req-btc-thresholds');

        const stored = await storedStochastic('BTCUSDT');
        const shipped = signalConfigFor('BTCUSDT');

        expect(stored.signal).toBe(
            verdict(
                stored.stochastic,
                shipped.stochastic.longThreshold,
                shipped.stochastic.shortThreshold,
            ),
        );
    });
});

describe('the live computation is handed the market configuration', () => {
    /**
     * Observed at the call, not inferred from the output.
     *
     * Two earlier versions of this file tried to infer it and both came out
     * vacuous: asserting on the stored strategy version proves the *repository*
     * resolved the market, and asserting that the stored reading matches the
     * market's thresholds proves nothing whenever the two threshold pairs happen
     * to agree on that series — which is most of the time, and silently.
     *
     * A control caught both. What is actually at stake is one argument at one
     * call site, so that is what is watched: what the fourth argument was.
     */
    it('passes the market thresholds to the signal it publishes', async () => {
        serving('ETHUSDT');

        const override = signalConfigFor('ETHUSDT');
        const seen = captureArguments();

        await analyzeMarket(logger, 'req-eth-arguments');

        expect(seen.length).toBeGreaterThan(0);
        // Every call, not the first: the primary and the fallback consensus are
        // two call sites and one of them passing would look identical from the
        // result.
        for (const argument of seen) {
            expect(argument).toBeDefined();
            expect(argument.stochastic).toEqual(override.stochastic);
        }
    });

    it('and the shipped pair for a market nobody configured', async () => {
        serving('BTCUSDT');

        const shipped = signalConfigFor('BTCUSDT');
        const seen = captureArguments();

        await analyzeMarket(logger, 'req-btc-arguments');

        expect(seen.length).toBeGreaterThan(0);

        for (const argument of seen) {
            expect(argument.stochastic).toEqual(shipped.stochastic);
        }
    });
});
