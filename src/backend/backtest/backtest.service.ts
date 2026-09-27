import { currentRegistry } from '../observability/registry.js';
import { getMarketData } from '../market/market.service.js';
import { marketDataProvider } from '../market/market.provider.js';
import { marketConfig } from '../config/market.config.js';
import { INDICATOR_SIGNAL_CONFIG, requiredCandleCount } from '../config/indicator.config.js';
import { assertCandleSeries } from '../market/candle-validation.js';

import { runWalkForward, DEFAULT_WALK_FORWARD_OPTIONS } from './walk-forward.js';
import { manifestFor } from './manifest.js';

import type { WalkForwardOptions, WalkForwardResult } from './walk-forward.js';
import type { ExperimentManifest } from './experiment.js';

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
 */
export async function runBacktest(
    options: Partial<WalkForwardOptions> = {},
): Promise<BacktestReport> {
    const startedAt = performance.now();

    try {
        return await runBacktestMeasured(options, startedAt);
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
): Promise<BacktestReport> {
    const resolved = { ...DEFAULT_WALK_FORWARD_OPTIONS, ...options };
    const needed = requiredCandles(resolved);

    const snapshot = await getMarketData();

    const candles = await marketDataProvider.getHistoricalCandles(needed);

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

    const result = runWalkForward(candles, resolved);

    return {
        ...result,
        symbol: marketConfig.symbol,
        candleInterval: marketConfig.candleInterval,
        candleCount: candles.length,
        from: candles[0]?.timestamp ?? 0,
        to: candles[candles.length - 1]?.timestamp ?? 0,
        currentPrice: snapshot.data.price.price,
        dataStale: snapshot.stale,
        dataAgeMs: snapshot.ageMs,
        requestedCandles: needed,
        shippedParameters: {
            longThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
            shortThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
        },
        options: resolved,
        manifest: manifestFor(
            result,
            candles,
            resolved,
            {
                id: `${marketConfig.symbol}-${marketConfig.candleInterval}-${candles.length}`,
                name: `${marketConfig.symbol} ${marketConfig.candleInterval}`,
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
                name: `${marketConfig.symbol}-${marketConfig.candleInterval}`,
                symbol: marketConfig.symbol,
                provider: marketConfig.provider,
                interval: marketConfig.candleInterval,
            },
            {
                longThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
                shortThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
            },
        ),
    };
}
