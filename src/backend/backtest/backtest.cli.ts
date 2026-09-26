/**
 * Walk-forward report, printed to the console.
 *
 * Deliberately a command and not an endpoint. The numbers describe how the
 * strategy behaved on past candles, and a panel that displays them invites a
 * reader to treat a backtest as a forecast. Nothing here is wired into the
 * dashboard, and adding that would be a separate decision.
 *
 *   npm run backtest
 *
 * Options may be overridden from the environment, which is how a run with
 * costs set to zero is used to separate the strategy's direction from the
 * cost of trading it:
 *
 *   BACKTEST_FEE_RATE=0 BACKTEST_SLIPPAGE_RATE=0 npm run backtest
 */
import { runBacktest } from './backtest.service.js';

import type { BacktestReport } from './backtest.service.js';
import type { WalkForwardOptions } from './walk-forward.js';

function numericEnv(name: string): number | undefined {
    const raw = process.env[name];

    if (raw === undefined || raw.trim() === '') {
        return undefined;
    }

    const value = Number(raw);

    return Number.isFinite(value) ? value : undefined;
}

function overridesFromEnv(): Partial<WalkForwardOptions> {
    const overrides: Partial<WalkForwardOptions> = {};

    const feeRate = numericEnv('BACKTEST_FEE_RATE');
    const slippageRate = numericEnv('BACKTEST_SLIPPAGE_RATE');
    const holdBars = numericEnv('BACKTEST_HOLD_BARS');
    const foldBars = numericEnv('BACKTEST_FOLD_BARS');
    const trainingBars = numericEnv('BACKTEST_TRAINING_BARS');
    const maxFolds = numericEnv('BACKTEST_MAX_FOLDS');

    if (feeRate !== undefined) {
        overrides.feeRate = feeRate;
    }

    if (slippageRate !== undefined) {
        overrides.slippageRate = slippageRate;
    }

    if (holdBars !== undefined) {
        overrides.holdBars = holdBars;
    }

    if (foldBars !== undefined) {
        overrides.foldBars = foldBars;
    }

    if (trainingBars !== undefined) {
        overrides.trainingBars = trainingBars;
    }

    if (maxFolds !== undefined) {
        overrides.maxFolds = maxFolds;
    }

    return overrides;
}

function percent(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
}

function number(value: number, digits = 3): string {
    return value.toFixed(digits);
}

function describe(report: BacktestReport): string {
    const lines: string[] = [];

    lines.push(`Символ: ${report.symbol}, свечи ${report.candleInterval}`);
    lines.push(
        `Свечей: ${report.candleCount} (запрошено ${report.requestedCandles}), ` +
            `${new Date(report.from).toISOString()} — ${new Date(report.to).toISOString()}`,
    );
    lines.push(`Текущая цена: ${report.currentPrice}`);

    if (report.candleCount < report.requestedCandles) {
        lines.push(
            'ВНИМАНИЕ: провайдер отдал меньше свечей, чем запрошено — выборка короче расчётной.',
        );
    }

    if (report.folds.length === 0) {
        lines.push('');
        lines.push(
            'Окна не сформированы: свечей не хватило на прогрев индикаторов плюс обучение и проверку.',
        );

        return lines.join('\n');
    }

    if (report.dataStale) {
        lines.push(
            `ВНИМАНИЕ: снимок рынка устарел на ${Math.round(report.dataAgeMs / 1000)} с`,
        );
    }

    lines.push(
        `Удержание позиции: ${report.options.holdBars} свеч, издержки ${number(
            report.options.feeRate * 10_000,
            1,
        )} бп + ${number(report.options.slippageRate * 10_000, 1)} бп проскальзывание за сторону`,
    );
    lines.push(
        `Окно проверки: ${report.options.foldBars} свечей, обучение ${report.options.trainingBars}, подбор порогов ${
            report.options.fitParameters ? 'включён' : 'выключен'
        }`,
    );
    lines.push('');

    const overall = report.overall;
    const baseline = report.baseline;

    lines.push('=== Все окна вместе (подобранные пороги) ===');
    lines.push(`Сделок: ${overall.trades}`);
    lines.push(
        `Сигналы: LONG ${overall.signalMix.long}, SHORT ${overall.signalMix.short}, NEUTRAL ${overall.signalMix.neutral}`,
    );
    lines.push(`Доля времени в позиции: ${percent(overall.exposure)}`);
    lines.push(`Прибыльных: ${percent(overall.winRate)}`);
    lines.push(`Итог: ${percent(overall.totalReturn)}`);
    lines.push(`Средняя сделка: ${percent(overall.averageTrade)}`);
    lines.push(
        `Профит-фактор: ${
            overall.profitFactor === null ? 'н/д (нет убытков)' : number(overall.profitFactor)
        }`,
    );
    lines.push(`Макс. просадка: ${percent(overall.maxDrawdown)}`);
    lines.push(`Шарп: ${number(overall.sharpeRatio, 2)}`);
    lines.push('');

    lines.push('=== Для сравнения: штатные пороги на тех же окнах ===');
    lines.push(`Сделок: ${baseline.trades}, итог: ${percent(baseline.totalReturn)}`);
    lines.push(
        `Прибыльных: ${percent(baseline.winRate)}, просадка: ${percent(baseline.maxDrawdown)}`,
    );
    lines.push('');

    lines.push('=== По окнам ===');
    for (const fold of report.folds) {
        const mark = fold.fitted ? 'подобран' : 'штатный';
        lines.push(
            `Окно ${fold.fold} (свечи ${fold.startIndex}–${fold.endIndex}, пороги ${fold.parameters.longThreshold}/${fold.parameters.shortThreshold}, ${mark}): ` +
                `сделок ${fold.metrics.trades}, прибыльных ${percent(fold.metrics.winRate)}, ` +
                `итог ${percent(fold.metrics.totalReturn)}, просадка ${percent(fold.metrics.maxDrawdown)}`,
        );
    }

    if (report.skippedFolds > 0) {
        lines.push('');
        lines.push(
            `Пропущено окон: ${report.skippedFolds} (в выборке не хватило свечей)`,
        );
    }

    lines.push('');
    lines.push(
        'Прошлые свечи не обещают будущих. Метрики выше — описание поведения на истории, а не прогноз.',
    );

    return lines.join('\n');
}

async function main(): Promise<void> {
    const report = await runBacktest(overridesFromEnv());

    console.log(describe(report));
}

main().catch((error: unknown) => {
    console.error('Не удалось выполнить бэктест:', error);

    process.exitCode = 1;
});
