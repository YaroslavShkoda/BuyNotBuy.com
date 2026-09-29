import { currentRegistry } from '../observability/registry.js';
import { getMarketData, resolveRequest } from '../market/market.service.js';
import { marketProviderFor } from '../market/market.provider.js';
import { marketConfig } from '../config/market.config.js';
import { requiredCandleCount, signalConfigFor } from '../config/indicator.config.js';
import { assertCandleSeries } from '../market/candle-validation.js';

import { runWalkForward, DEFAULT_WALK_FORWARD_OPTIONS } from './walk-forward.js';
import { manifestFor } from './manifest.js';

import type { WalkForwardOptions, WalkForwardResult } from './walk-forward.js';
import type { ExperimentManifest } from './experiment.js';
import type { MarketRequest } from '../market/capability.js';

/**
 * Which code produced the run, when there is any.
 *
 * Read from the environment rather than by shelling out to git: a backtest
 * should not depend on a VCS being present, and a packaged deployment has
 * none. Absent, the manifest records null and says so, which is honest — the
 * alternative is a fabricated hash.
 */
const BACKTEST_COMMIT = process.env['BACKTEST_COMMIT'] ?? null;

export interface BacktestReport extends WalkForwardResult {
    symbol: string;
    candleInterval: string;
    /** Candles the report was computed from. */
    candleCount: number;
    /** First and last bar of the sample, so the report states its period. */
    from: number;
    to: number;
    /** The live snapshot, kept so the report can name the current price. */
    currentPrice: number;
    dataStale: boolean;
    dataAgeMs: number;
    /** How many bars were fetched to fill the warm-up plus the windows. */
    requestedCandles: number;
    shippedParameters: {
        longThreshold: number;
        shortThreshold: number;
    };
    options: WalkForwardOptions;
    /**
     * Everything needed to repeat this exact run.
     *
     * Built from the result object rather than from the inputs, so what is
     * stored is what was produced. A number on its own is a claim with nothing
     * to check it against; this is what makes it falsifiable.
     */
    manifest: ExperimentManifest;
}

function requiredCandles(options: WalkForwardOptions): number {
    return (
        requiredCandleCount() +
        options.trainingBars +
        options.foldBars * options.maxFolds
    );
}

/**
 * Runs a walk-forward over real history.
 *
 * The live snapshot is sized for the indicator warm-up, which is all the
 * dashboard needs but leaves a backtest with nothing to evaluate: every bar
 * would be spent warming up. History is therefore fetched separately, sized
 * to the warm-up plus the training and evaluation windows, and the live
 * snapshot is read only to name the current price.
 *
 * **The market is a parameter, and it was not one until now.** This function
 * had no way to be told what to backtest: it read the configured market, fetched
 * that, and then labelled the result with the same configured value. The two
 * always agreed, which is exactly why the defect was invisible — a report whose
 * symbol came from the configuration rather than from the measurement cannot
 * disagree with the data, so nothing ever says the label is wrong.
 *
 * It also fetched through the module singleton instead of the router, so a
 * backtest could not have reached a market the live path could not, even after
 * the router learned to serve several. Both are the M3 defect one layer up.
 */
export async function runBacktest(
    options: Partial<WalkForwardOptions> = {},
    request: MarketRequest = resolveRequest(),
): Promise<BacktestReport> {
    const startedAt = performance.now();

    try {
        return await runBacktestMeasured(options, startedAt, request);
    } finally {
        // A backtest that throws still took the time, and the time is the only
        // thing that says the run got too big to finish. Recorded outside the
        // successful path for the same reason the database timing is: the
        // duration nobody waits for is the one worth measuring.
        currentRegistry().observe('backtest_duration', performance.now() - startedAt);
    }
}

async function runBacktestMeasured(
    options: Partial<WalkForwardOptions>,
    startedAt: number,
    request: MarketRequest,
): Promise<BacktestReport> {
    const resolved = { ...DEFAULT_WALK_FORWARD_OPTIONS, ...options };
    const needed = requiredCandles(resolved);

    const snapshot = await getMarketData(request);

    // Routed, not the singleton: the backtest and the live path now ask the
    // same question of the same capability table, so a market the service
    // cannot serve is refused here for the stated reason rather than answered
    // with BTC because BTC happened to be configured.
    const candles = await marketProviderFor(request.instrument).getHistoricalCandles(needed);

    // The same integrity checks the live path applies, so a backtest cannot
    // quietly measure a series the live service would have rejected. The cap
    // is raised because a multi-page history is larger than any single
    // response the provider is allowed to return.
    assertCandleSeries(
        candles,
        Date.now(),
        marketConfig.provider,
        needed + 1,
    );

    // Resolved once, here, for the market this run is about, and handed to the
    // walk-forward. Every number the run reports about its own parameters, and
    // every pair a fold falls back to, comes from this one object: reading the
    // global at each site would let a per-asset override exist and be recorded
    // as though it had not been used.
    const signalConfig = signalConfigFor(request.instrument);

    const result = runWalkForward(candles, resolved, signalConfig);
    return {
        ...result,
        // Named from what was measured, not from what was configured. The
        // manifest is the record that a result can be reproduced, and a record
        // whose symbol is a config value says only that the config was read —
        // it cannot tell a reader which market the numbers came from.
        symbol: request.instrument,
        candleInterval: request.interval,
        candleCount: candles.length,
        from: candles[0]?.timestamp ?? 0,
        to: candles[candles.length - 1]?.timestamp ?? 0,
        currentPrice: snapshot.data.price.price,
        dataStale: snapshot.stale,
        dataAgeMs: snapshot.ageMs,
        requestedCandles: needed,
        shippedParameters: {
            longThreshold: signalConfig.stochastic.longThreshold,
            shortThreshold: signalConfig.stochastic.shortThreshold,
        },
        options: resolved,
        manifest: manifestFor(
            result,
            candles,
            resolved,
            {
                id: `${request.instrument}-${request.interval}-${candles.length}`,
                name: `${request.instrument} ${request.interval}`,
                // From the first bar's own timestamp rather than the clock, so
                // a run repeated on the same data produces the same manifest
                // and a diff between them shows a real change instead of the
                // time of day it was run.
                recordedAt: candles[0]?.timestamp ?? 0,
                // A working tree has no commit, and refusing to record that
                // would mean the least trustworthy runs — the ones being
                // developed — are the ones that get no manifest at all.
                commit: BACKTEST_COMMIT,
            },
            {
                name: `${request.instrument}-${request.interval}`,
                symbol: request.instrument,
                provider: marketConfig.provider,
                interval: request.interval,
            },
            {
                // The parameters the run actually used, for the market it
                // actually ran on. Reading the global here while `shippedParameters`
                // reads the resolved one would produce a manifest that
                // contradicts the report printed beside it.
                longThreshold: signalConfig.stochastic.longThreshold,
                shortThreshold: signalConfig.stochastic.shortThreshold,
            },
        ),
    };
}
