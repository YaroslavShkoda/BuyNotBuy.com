import { z } from 'zod';

export interface IndicatorSignalOverrides {
    stochastic?: Partial<{
        longThreshold: number;
        shortThreshold: number;
        center: number;
    }>;
    ema?: Partial<{
        confirmBars: number;
        convictionScalePercent: number;
    }>;
    momentum?: Partial<{
        deadbandPercent: number;
        convictionScalePercent: number;
    }>;
}

const retiredStrategyVariables = [
    'CONSENSUS_MIN_AGREEING',
    'CONSENSUS_MIN_CONVICTION',
    'CONSENSUS_WEIGHT_MODEL',
    'CONSENSUS_CONFIDENCE_MODEL',
    'REGIME_VOLATILITY_NORMAL',
    'REGIME_VOLATILITY_HIGH',
    'REGIME_VOLATILITY_EXTREME',
    'REGIME_TREND_WEAK',
    'REGIME_TREND_STRONG',
    'REGIME_DIRECTIONAL',
    'REGIME_BASELINE_DAYS',
    'REGIME_MINIMUM_DAYS',
    'REGIME_BASELINE_BARS',
    'REGIME_MINIMUM_BARS',
    'SIGNAL_REPUBLISH_MOVE_PERCENT',
    'SIGNAL_REPUBLISH_CONFIDENCE_DELTA',
    'SIGNAL_EXPIRY_BARS',
    'SIGNAL_COOLDOWN_BARS',
    'SIGNAL_INVALIDATION_PERCENT',
    'OUTCOME_HORIZONS',
    'OUTCOME_BREAKEVEN_PERCENT',
    'OUTCOME_TRACK_EXCURSIONS',
    'INDICATOR_EMA_PERIOD',
    'INDICATOR_STOCHASTIC_PERIOD',
    'INDICATOR_MOMENTUM_PERIOD',
    'INDICATOR_ATR_PERIOD',
    'INDICATOR_RSI_PERIOD',
    'INDICATOR_BOLLINGER_PERIOD',
    'INDICATOR_BOLLINGER_STDDEV',
    'INDICATOR_ADX_PERIOD',
    'INDICATOR_MACD_FAST_PERIOD',
    'INDICATOR_MACD_SLOW_PERIOD',
    'INDICATOR_MACD_SIGNAL_PERIOD',
    'INDICATOR_EMA_WARMUP_MULTIPLIER',
    'INDICATOR_DIVERGENCE_LEFT_WINDOW',
    'INDICATOR_DIVERGENCE_RIGHT_WINDOW',
    'INDICATOR_DIVERGENCE_MAX_DISTANCE',
    'INDICATOR_DIVERGENCE_MAX_AGE',
    'INDICATOR_ASSET_CONFIG',
] as const;

const retiredSettings = retiredStrategyVariables.filter(
    (name) => process.env[name] !== undefined,
);

if (retiredSettings.length > 0) {
    throw new Error(
        `${retiredSettings.join(', ')} moved into STRATEGY_PROFILE=baseline; remove these per-setting overrides`,
    );
}

/** Strategy policy is selected as one reviewed unit. */
const StrategyProfileNameSchema = z.enum(['baseline']);
type StrategyProfileName = z.infer<typeof StrategyProfileNameSchema>;

/**
 * The single shipped profile keeps today's strategy arithmetic intact.
 * Additional profiles should be added only with an explicit, reviewed policy
 * and a reproducible backtest; operators select a profile instead of setting
 * each related threshold independently.
 */
const STRATEGY_PROFILES = {
    baseline: {
        indicators: {
            periods: {
                ema: 300,
                stochastic: 100,
                momentum: 100,
                atr: 14,
                rsi: 14,
                bollinger: 20,
                bollingerStdDev: 2,
                adx: 14,
                macdFast: 12,
                macdSlow: 26,
                macdSignal: 9,
                emaWarmupMultiplier: 3,
                divergence: {
                    leftWindow: 2,
                    rightWindow: 2,
                    maxDistance: 5,
                    maxAge: 120,
                },
            },
            signal: {
                stochastic: { longThreshold: 15, shortThreshold: 80, center: 50 },
                ema: { confirmBars: 3, convictionScalePercent: 2 },
                momentum: {
                    deadbandPercent: 0.15,
                    convictionScalePercent: 3,
                },
            },
            assetSignalOverrides: {} as Record<
                string,
                IndicatorSignalOverrides
            >,
        },
        consensus: {
            minimumAgreeing: 2,
            minimumMeanConviction: 0.25,
            weightModel: 'continuous',
            confidenceModel: 'wilson',
        },
        regime: {
            volatility: { normal: 0.5, high: 1.5, extreme: 2.5 },
            trend: { weak: 25, strong: 50 },
            directional: 60,
            baselineDays: 30,
            minimumDays: 2,
            baselineBars: 720,
            minimumBars: 50,
        },
        lifecycle: {
            republishPriceMovePercent: 0.5,
            republishConfidenceDelta: 5,
            expiryBars: 72,
            cooldownBars: 12,
            invalidationPercent: 3,
        },
        outcome: {
            horizons: [1, 3, 6, 12, 24, 48, 72],
            breakevenPercent: 0.1,
            trackExcursions: true,
        },
    },
} as const;

type StrategyProfile = (typeof STRATEGY_PROFILES)[StrategyProfileName];

const selectedProfile = StrategyProfileNameSchema.parse(
    process.env.STRATEGY_PROFILE ?? 'baseline',
);

export const strategyProfileName: StrategyProfileName = selectedProfile;
export const strategyProfile: StrategyProfile = STRATEGY_PROFILES[selectedProfile];
