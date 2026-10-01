/**
 * Prints what the system published against what the market did.
 *
 * **This is the command line the performance layer never had.** Four hundred
 * and fifty-four lines of code and a thousand one hundred and fifty-four lines
 * of tests, with no way to be asked a question, is a worse state than having
 * none of it: the tests say it works, the architecture map says it is stranded,
 * and neither produces a number.
 *
 * It lives in `research/` and not beside the layer because a command line is an
 * entry point, and entry points are declared in one place. Putting it there
 * would have meant either declaring the layer itself a composition root — which
 * is what you do to silence a finding rather than to fix one — or leaving the
 * layer looking unreachable while something plainly could reach it.
 *
 * **What this prints is a statement about the past and nothing else.** Every
 * row is filtered by a horizon whose window had closed when it was asked for,
 * the exclusions are printed next to the result rather than beneath it, and a
 * sample too small to measure says so instead of reporting a rate computed from
 * two signals.
 */

import { performanceConfig } from '../performance/performance.config.js';
import { computeMetrics } from '../performance/performance.js';
import { calibrate, reliability } from '../performance/calibration.js';
import { byRegime } from '../performance/regime-performance.js';
import { loadMeasuredSignals } from '../performance/performance-load.repository.js';
import { toPerformanceSamples, type HorizonSelector } from '../performance/samples.js';

import { closePool } from '../db/pool.js';

import { marketConfig } from '../config/market.config.js';

interface Options {
    readonly symbol: string;
    readonly horizonBars: number;
    readonly graceMs: number;
    readonly limit: number;
}

const HOUR_MS = 3_600_000;

/**
 * The seam converts bars to milliseconds, which is only a horizon if a bar is an
 * hour. That assumption is printed rather than hidden: a reader comparing this
 * table against one measured on 5 minute bars would otherwise be comparing
 * different experiments without being told.
 */
const BARS_ASSUMED_MS = HOUR_MS;

function parse(argv: readonly string[]): Options {
    // Not `valueOf`: that is a name every object inherits, and a local shadowing
    // it is a local whose call sites read like method calls.
    const flagValue = (flag: string, fallback: string): string => {
        const at = argv.indexOf(flag);

        return at === -1 ? fallback : (argv[at + 1] ?? fallback);
    };

    const horizonBars = Number(flagValue('--horizon', '8'));

    if (!Number.isInteger(horizonBars) || horizonBars <= 0) {
        throw new Error(
            `--horizon must be a whole number of bars above zero, and ${String(horizonBars)} is not.`,
        );
    }

    return {
        symbol: flagValue('--symbol', marketConfig.symbol),
        horizonBars,
        graceMs: Number(flagValue('--grace', '0')),
        limit: Number(flagValue('--limit', '5000')),
    };
}

function percent(value: number | null): string {
    if (value === null) {
        return 'не измерено';
    }

    return `${(value * 100).toFixed(1)}%`;
}

async function render(options: Options, asOf: number): Promise<string> {
    const provider = marketConfig.provider;
    const interval = marketConfig.candleInterval;
    const horizon: HorizonSelector = {
        bars: options.horizonBars,
        asOf,
        graceMs: options.graceMs,
    };

    const loaded = await loadMeasuredSignals(
        { symbol: options.symbol, provider, interval },
        options.horizonBars,
        { limit: options.limit },
    );

    const report = toPerformanceSamples(loaded.signals, horizon);
    const metrics = computeMetrics(report.samples);
    const calibration = calibrate(report.samples);
    const grade = reliability(report.samples);
    const regimes = byRegime(report.samples);
    const floor = performanceConfig.minimumSample;

    const lines = [
        `Рынок        ${options.symbol} ${provider} ${interval}`,
        `Горизонт     ${options.horizonBars} баров = ${(options.horizonBars * BARS_ASSUMED_MS / HOUR_MS).toFixed(0)} ч (бар принят за час), допуск ${options.graceMs} мс`,
        `Момент       ${new Date(asOf).toISOString()}`,
        `Порог        ${floor} сигналов — ниже него число не печатается`,
        '',
        'Что измерено',
        `  прочитано строк     ${loaded.read}`,
        `  сигналов            ${loaded.signals.length}`,
        `  измерено            ${report.measured}`,
        `  без заявления       ${loaded.withoutClaim}   нечем калибровать`,
        `  не разрешено        ${report.excluded.unresolved}   окно ещё открыто`,
        `  истекло             ${report.excluded.expired}   не хватило баров`,
        `  чужой горизонт      ${report.excluded.otherHorizon}   измерялось не это`,
        '',
        'Метрики',
        `  всего               ${metrics.total}`,
        `  верно / неверно     ${metrics.correct} / ${metrics.incorrect}`,
        `  в ноль / не решено  ${metrics.flat} / ${metrics.unresolved}`,
        `  точность            ${percent(metrics.accuracy)}`,
        `  направление         ${percent(metrics.directionAccuracy)}`,
        `  ожидание            ${percent(metrics.expectancy)}`,
        `  проф-фактор         ${ratio(metrics.profitFactor)}`,
        '',
        // The scope line is the answer's own account of what it covers. Without
        // it the calibration below is a number about an unnamed set of markets,
        // and a reader has no way to tell a single-market figure from a blend.
        `Калибровка: сколько заявляли и сколько сбылось` +
            `${calibration.scope === null ? '' : ` (${calibration.scope})`}`,
        `  ${'корзина'.padEnd(12)} ${'сигналов'.padStart(8)} ${'заявлено'.padStart(9)} ${'сбылось'.padStart(9)} ${'разрыв'.padStart(9)}`,
    ];

    for (const point of calibration.points) {
        lines.push(
            `  ${percent(point.claimed).padEnd(12)} ` +
                String(point.total).padStart(8) +
                ` ${percent(point.claimed).padStart(9)} ` +
                `${percent(point.actual).padStart(9)} ` +
                `${point.gap === null ? '—' : `${point.gap > 0 ? '+' : ''}${(point.gap * 100).toFixed(1)} п.п.`}`.padStart(9),
        );
    }

    lines.push(
        '',
        `  балл               ${ratio(calibration.score)}`,
        `  заявляем в среднем ${percent(calibration.meanClaimed)}`,
        `  сбывается в среднем ${percent(calibration.meanActual)}`,
        '',
        'Надёжность',
        `  балл               ${ratio(grade.score)}`,
        `  дрейф              ${grade.drift === null ? 'не измерено' : percent(grade.drift)}`,
        `  вердикт            ${grade.verdict}`,
    );

    if (regimes.byRegime.size > 0) {
        lines.push('', 'По режимам');

        for (const [regime, entry] of [...regimes.byRegime].sort()) {
            lines.push(
                `  ${String(regime).padEnd(12)} ${String(entry.metrics.total).padStart(6)}` +
                    `  точность ${percent(entry.metrics.accuracy).padStart(12)}` +
                    `  ожидание ${percent(entry.metrics.expectancy).padStart(12)}` +
                    `  вклад ${percent(entry.lift).padStart(9)}`,
            );
        }

        lines.push(
            `  разброс            ${percent(regimes.spread)}   сильнее: ${regimes.strongest ?? '—'}`,
        );
    }

    lines.push(
        '',
        'Числа выше — о прошлом. Ничего в этом выводе не меняет поведение системы.',
    );

    return lines.join('\n');
}

function ratio(value: number | null): string {
    return value === null ? 'не измерено' : value.toFixed(2);
}

async function main(): Promise<void> {
    const options = parse(process.argv.slice(2));
    const asOf = Date.now();

    try {
        process.stdout.write(`${await render(options, asOf)}\n`);
    } finally {
        await closePool();
    }
}

// A stack trace is for a defect in this file. Being handed a bad flag is the
// caller's situation, and it deserves a sentence rather than a call graph.
try {
    await main();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
