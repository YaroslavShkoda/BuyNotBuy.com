import { z } from 'zod';
import type { IndicatorSignalOverrides as ProfileIndicatorSignalOverrides } from './strategy.profile.js';
import { strategyProfile, strategyProfileName } from './strategy.profile.js';

export type IndicatorSignalOverrides = ProfileIndicatorSignalOverrides;

const IndicatorConfigSchema = z
    .object({
        emaPeriod: z.number().int().positive(),
        stochasticPeriod: z.number().int().positive(),
        momentumPeriod: z.number().int().positive(),
        atrPeriod: z.number().int().positive(),
        rsiPeriod: z.number().int().positive(),
        bollingerPeriod: z.number().int().positive(),
        bollingerStdDev: z.number().min(0),
        adxPeriod: z.number().int().positive(),
        macdFastPeriod: z.number().int().positive(),
        macdSlowPeriod: z.number().int().positive(),
        macdSignalPeriod: z.number().int().positive(),
        emaWarmupMultiplier: z.number().int().positive(),
        divergence: z.object({
            leftWindow: z.number().int().positive(),
            rightWindow: z.number().int().positive(),
            maxDistance: z.number().int().positive(),
            maxAge: z.number().int().positive(),
        }),
    })
    .refine((config) => config.macdFastPeriod < config.macdSlowPeriod, {
        message: 'MACD fast period must be shorter than its slow period',
        path: ['macdFastPeriod'],
    });

export type IndicatorConfig = z.infer<typeof IndicatorConfigSchema>;

const periods = strategyProfile.indicators.periods;

export const indicatorConfig: IndicatorConfig = IndicatorConfigSchema.parse({
    emaPeriod: periods.ema,
    stochasticPeriod: periods.stochastic,
    momentumPeriod: periods.momentum,
    atrPeriod: periods.atr,
    rsiPeriod: periods.rsi,
    bollingerPeriod: periods.bollinger,
    bollingerStdDev: periods.bollingerStdDev,
    adxPeriod: periods.adx,
    macdFastPeriod: periods.macdFast,
    macdSlowPeriod: periods.macdSlow,
    macdSignalPeriod: periods.macdSignal,
    emaWarmupMultiplier: periods.emaWarmupMultiplier,
    divergence: periods.divergence,
});

const IndicatorSignalConfigSchema = z
    .object({
        stochastic: z.object({
            longThreshold: z.number().min(0).max(100),
            shortThreshold: z.number().min(0).max(100),
            center: z.number().min(0).max(100),
        }),
        ema: z.object({
            confirmBars: z.number().int().positive(),
            convictionScalePercent: z.number().positive(),
        }),
        momentum: z.object({
            deadbandPercent: z.number().min(0),
            convictionScalePercent: z.number().positive(),
        }),
    })
    .refine(
        ({ stochastic }) =>
            stochastic.longThreshold < stochastic.center &&
            stochastic.center < stochastic.shortThreshold,
        {
            message: 'Stochastic long threshold must be below center and center below short threshold',
            path: ['stochastic'],
        },
    )
    .refine(
        ({ momentum }) => momentum.deadbandPercent < momentum.convictionScalePercent,
        {
            message: 'Momentum conviction scale must exceed its deadband',
            path: ['momentum', 'convictionScalePercent'],
        },
    );

export const INDICATOR_SIGNAL_CONFIG = strategyProfile.indicators.signal;
IndicatorSignalConfigSchema.parse(INDICATOR_SIGNAL_CONFIG);

export type IndicatorSignalConfig = typeof INDICATOR_SIGNAL_CONFIG;

export interface ResolvedIndicatorSignalConfig {
    stochastic: {
        longThreshold: number;
        shortThreshold: number;
        center: number;
    };
    ema: {
        confirmBars: number;
        convictionScalePercent: number;
    };
    momentum: {
        deadbandPercent: number;
        convictionScalePercent: number;
    };
}

const IndicatorOverrideSchema = z
    .object({
        stochastic: z
            .object({
                longThreshold: z.coerce.number().min(0).max(100).optional(),
                shortThreshold: z.coerce.number().min(0).max(100).optional(),
                center: z.coerce.number().min(0).max(100).optional(),
            })
            .strict()
            .optional(),
        ema: z
            .object({
                confirmBars: z.coerce.number().int().min(1).max(50).optional(),
                convictionScalePercent: z.coerce.number().min(0).max(100).optional(),
            })
            .strict()
            .optional(),
        momentum: z
            .object({
                deadbandPercent: z.coerce.number().min(0).max(100).optional(),
                convictionScalePercent: z.coerce.number().min(0).max(1000).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

const IndicatorOverridesSchema = z.record(
    z.string().regex(/^[A-Z0-9]+$/),
    IndicatorOverrideSchema,
);

export const INDICATOR_ASSET_CONFIG = IndicatorOverridesSchema.parse(
    strategyProfile.indicators.assetSignalOverrides,
) as Record<string, IndicatorSignalOverrides>;

for (const [instrument, override] of Object.entries(INDICATOR_ASSET_CONFIG)) {
    try {
        IndicatorSignalConfigSchema.parse({
            stochastic: {
                ...INDICATOR_SIGNAL_CONFIG.stochastic,
                ...override.stochastic,
            },
            ema: { ...INDICATOR_SIGNAL_CONFIG.ema, ...override.ema },
            momentum: {
                ...INDICATOR_SIGNAL_CONFIG.momentum,
                ...override.momentum,
            },
        });
    } catch (error) {
        const detail =
            error instanceof z.ZodError
                ? z.prettifyError(error)
                : String(error);
        throw new Error(
            `Strategy profile ${strategyProfileName} has invalid signal thresholds for ${instrument}: ${detail}`,
        );
    }
}

export function emaDisplayName(period: number): string {
    return `EMA ${period}`;
}

export function momentumDisplayName(period: number): string {
    return `Momentum ${period}`;
}

export const STOCHASTIC_THRESHOLD_GRID: readonly {
    longThreshold: number;
    shortThreshold: number;
}[] = [
    { longThreshold: 5, shortThreshold: 95 },
    { longThreshold: 10, shortThreshold: 90 },
    { longThreshold: 15, shortThreshold: 85 },
    { longThreshold: 20, shortThreshold: 80 },
    { longThreshold: 25, shortThreshold: 75 },
    { longThreshold: 10, shortThreshold: 80 },
    { longThreshold: 15, shortThreshold: 80 },
    { longThreshold: 20, shortThreshold: 70 },
];

export function signalConfigFor(instrument: string): ResolvedIndicatorSignalConfig {
    return resolveSignalConfig(instrument, INDICATOR_ASSET_CONFIG);
}

export function resolveSignalConfig(
    instrument: string,
    assetOverrides: Record<string, IndicatorSignalOverrides>,
): ResolvedIndicatorSignalConfig {
    const override = assetOverrides[instrument.toUpperCase()];

    if (override === undefined) {
        return INDICATOR_SIGNAL_CONFIG;
    }

    return IndicatorSignalConfigSchema.parse({
        stochastic: {
            ...INDICATOR_SIGNAL_CONFIG.stochastic,
            ...override.stochastic,
        },
        ema: { ...INDICATOR_SIGNAL_CONFIG.ema, ...override.ema },
        momentum: { ...INDICATOR_SIGNAL_CONFIG.momentum, ...override.momentum },
    });
}

export function hasAssetSignalConfig(
    instrument: string,
    assetOverrides: Record<string, IndicatorSignalOverrides> = INDICATOR_ASSET_CONFIG,
): boolean {
    return assetOverrides[instrument.toUpperCase()] !== undefined;
}

export function requiredCandleCount(): number {
    return Math.max(
        indicatorConfig.emaPeriod * indicatorConfig.emaWarmupMultiplier,
        indicatorConfig.stochasticPeriod,
        indicatorConfig.momentumPeriod + 1,
        indicatorConfig.macdSlowPeriod + indicatorConfig.macdSignalPeriod,
        indicatorConfig.rsiPeriod + 1,
        indicatorConfig.atrPeriod + 1,
    );
}
