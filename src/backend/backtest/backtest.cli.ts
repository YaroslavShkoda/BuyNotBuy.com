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
import { DEFAULT_WALK_FORWARD_OPTIONS } from './walk-forward.js';
import { ExecutionConfigParser } from './execution.js';

import type { ExecutionConfig } from './execution.js';
import { checkReplayable } from './experiment.js';
import type { BacktestReport } from './backtest.service.js';
import type { WalkForwardOptions } from './walk-forward.js';

/**
 * The three fills, named in the output.
 *
 * Printed because a cost figure with no fill assumption beside it is half a
 * claim: "0.17% per side" is a different statement with `intrabar` behind it
 * than with `next_open`, and only one of the two is what the run assumed.
 */
const EXECUTION_MODEL_LABELS: Record<ExecutionConfig['model'], string> = {
    next_open: 'исполнение по открытию следующей свечи',
    next_close: 'исполнение по закрытию следующей свечи',
    intrabar: 'исполнение по худшему краю бара (пессимистично)',
};

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

    // The two legacy settings are folded into the execution model rather than
    // replaced by it, so an operator who has been overriding a fee for a year
    // keeps overriding it — and gets the fill assumption stated at the same
    // time, which the two scalars could never do on their own.
    if (feeRate !== undefined || slippageRate !== undefined) {
        overrides.execution = ExecutionConfigParser.parse({
            ...DEFAULT_WALK_FORWARD_OPTIONS.execution,
            ...(feeRate === undefined
                ? {}
                : {
                      takerFeeRate: feeRate,
                      makerFeeRate: Math.min(
                          DEFAULT_WALK_FORWARD_OPTIONS.execution.makerFeeRate,
                          feeRate,
                      ),
                  }),
            ...(slippageRate === undefined
                ? {}
                : { slippageRate }),
        });
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

    const execution = report.options.execution;
    const fee =
        execution.liquidity === 'maker'
            ? execution.makerFeeRate
            : execution.takerFeeRate;

    lines.push(
        `Удержание позиции: ${report.options.holdBars} свеч. Исполнение: ${
            EXECUTION_MODEL_LABELS[execution.model]
        }, ${execution.liquidity === 'maker' ? 'maker' : 'taker'}.`,
    );
    lines.push(
        `Издержки за сторону: ${number(fee * 10_000, 1)} бп комиссия + ${number(
            execution.spreadRate * 10_000,
            1,
        )} бп спред + ${number(execution.slippageRate * 10_000, 1)} бп проскальзывание`,
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
    lines.push(`Макс. просадка: ${percent(overall.maxDrawdown)} (${overall.maxDrawdownBars} свечей)`);
    lines.push(`Шарп: ${number(overall.sharpeRatio, 2)}`);
    lines.push('');

    lines.push('=== Для сравнения: штатные пороги на тех же окнах ===');
    lines.push(`Сделок: ${baseline.trades}, итог: ${percent(baseline.totalReturn)}`);
    lines.push(
        `Прибыльных: ${percent(baseline.winRate)}, просадка: ${percent(baseline.maxDrawdown)}`,
    );
    lines.push('');

    // The section that decides whether any of the above means anything. A
    // strategy is only interesting relative to what else could have been done
    // with the same money over the same bars, and a report that omits the
    // comparison cannot be read as anything but "it went up" or "it went down".
    lines.push('=== С чем сравнивать (те же свечи, те же издержки) ===');
    for (const benchmark of [
        report.benchmarks.buyAndHold,
        report.benchmarks.randomEntry,
    ]) {
        lines.push(
            `${benchmark.label}: итог ${percent(benchmark.totalReturn)}, ` +
                `просадка ${percent(benchmark.maxDrawdown)}`,
        );
    }
    lines.push('');

    const excess = report.excessOverBuyAndHold;
    const overRandom =
        report.overall.trades > 0
            ? report.overall.totalReturn - report.benchmarks.randomEntry.totalReturn
            : null;

    lines.push('=== Вердикт ===');
    lines.push(
        excess === null
            ? 'Сделок не было — сравнивать не с чем.'
            : `Против buy & hold: ${percent(excess)}.`,
    );
    lines.push(
        overRandom === null
            ? 'Против случайного входа: сделок не было.'
            : `Против случайного входа: ${percent(overRandom)}.` +
                  ' Положительное значение означает, что тайминг сигнала несёт информацию сверх шума.',
    );

    if (excess !== null && excess < 0) {
        lines.push(
            'ВНИМАНИЕ: стратегия проиграла buy & hold. Она проводит время в позиции ' +
                'и платит издержки за каждую сделку, а рынок за это время вырос.',
        );
    }
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

/**
 * What this number was measured on, printed under it.
 *
 * A backtest figure on its own is a claim with nothing to check it against.
 * The dataset's checksum, the execution assumptions and the commit are what
 * make it falsifiable, and a run whose folds failed validation says so here
 * rather than in a report nobody reads.
 */
function describeProvenance(report: BacktestReport): string {
    const lines: string[] = ['', 'Происхождение результата'];

    const checksum = report.manifest.dataset.checksum;

    lines.push(
        `  Данные:     ${report.manifest.dataset.symbol} ${report.manifest.dataset.interval} ` +
            `(${report.manifest.dataset.provider}), ${report.manifest.dataset.bars} баров ` +
            `с ${new Date(report.manifest.dataset.from).toISOString().slice(0, 10)}`,
    );
    lines.push(`  Контрольная сумма: ${checksum.slice(0, 16)}…`);

    const execution = report.manifest.execution;

    lines.push(
        `  Исполнение: ${execution.model}, ${execution.liquidity}, ` +
            `комиссия ${execution.takerFeeRate}, проскальзывание ${execution.slippageRate}, спред ${execution.spreadRate}`,
    );

    if (report.manifest.commit !== null) {
        lines.push(`  Код:        ${report.manifest.commit.slice(0, 7)}`);
    }

    const rejected = report.manifest.folds.filter(
        (fold) => !fold.validationAccepted,
    );

    if (rejected.length > 0) {
        lines.push(
            `  Валидация:  ${rejected.length} из ${report.manifest.folds.length} складок отвергнуты ` +
                `(номера: ${rejected.map((fold) => fold.fold).join(', ')})`,
        );
    }

    const readiness = checkReplayable(report.manifest, report.manifest.commit);

    if (!readiness.replayable) {
        lines.push('  Повторяемость: НЕТ');
        for (const problem of readiness.problems) {
            lines.push(`    - ${problem}`);
        }
    }

    return lines.join('\n');
}

async function main(): Promise<void> {
    const report = await runBacktest(overridesFromEnv());

    console.log(describe(report));
    console.log(describeProvenance(report));
}

main().catch((error: unknown) => {
    console.error('Не удалось выполнить бэктест:', error);

    process.exitCode = 1;
});
