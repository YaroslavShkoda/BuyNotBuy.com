/**
 * Is the number called confidence a confidence?
 *
 * Prints the reliability diagram for every rule that produces one, on both
 * Binance series. The measurement and its tests are in
 * `confidence-calibration.ts`.
 */

import { createDonchian } from '../strategies/donchian.js';
import { createDonchianTrendGated } from '../strategies/donchian-trend-gated.js';
import type { StrategyModule } from '../strategies/types.js';
import { createVolatilityTrend } from '../strategies/volatility-trend.js';
import { collectConfidences, reliability } from './confidence-calibration.js';
import { loadDaily } from './threshold-null.js';

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

const MODULES: ReadonlyArray<{ readonly label: string; readonly module: StrategyModule }> = [
    { label: 'donchian-20', module: createDonchian({ channelPeriod: 20 }) },
    { label: 'donchian-trend-gated', module: createDonchianTrendGated() },
    { label: 'volatility-trend', module: createVolatilityTrend() },
];

console.log('='.repeat(96));
console.log("B9. ЧТО ОЗНАЧАЕТ ЧИСЛО, КОТОРОЕ НАЗЫВАЮТ УВЕРЕННОСТЬЮ");
console.log('='.repeat(96));
console.log(
    'Бары, разложенные по корзинам того числа, которое выдало правило, и доля\n' +
        'соседних баров, что выросла. Калиброванное число — диагональ: корзина 0.6\n' +
        'выигрывает в 60% случаев. Наклонённая, но неверно отмасштабированная —\n' +
        'растущая кривая не по диагонали. Пустая — ровная.\n',
);

const summary: string[] = [];

for (const file of ['btcusdt-1d-binance.csv', 'ethusdt-1d.csv']) {
    const candles = loadDaily(file);

    console.log(`${file} — ${candles.length} дневных баров`);
    console.log('─'.repeat(96));

    for (const { label, module } of MODULES) {
        const rows = collectConfidences(module, candles);

        if (rows.length === 0) {
            summary.push(`${label} на ${file}: ни одного сигнала`);

            continue;
        }

        const report = reliability(rows);
        const table = report.bins
            .filter((bin) => bin.bars > 0)
            .map((bin) => ({
                корзина: bin.label,
                баров: bin.bars,
                'доля роста': bin.bars >= 20 ? pct(bin.winShare) : '— (мало)',
                'ср. выход': bin.bars >= 20 ? pct(bin.meanForward) : '— (мало)',
            }));

        console.log(`\n  ${label} — сигналов ${rows.length}`);
        console.table(table);

        summary.push(
            `${label} на ${file}: ${report.verdict}` +
                ` (в верхней половине диапазона ${report.topHalfBars} баров, ` +
                `в крупнейшей корзине ${report.largestBin})`,
        );
    }

    console.log('');
}

console.log('='.repeat(96));
console.log('ИТОГ');
console.log('='.repeat(96));
for (const line of summary) {
    console.log('  ' + line);
}

console.log(
    '\n  «too-few-bars» — это не «плохо», это «неизвестно», и разница существенна.\n' +
        '  Пять с половиной лет дневных баров дают 131 сигнал donchian-20, и три\n' +
        '  из них попадают в корзину 0.50–0.60. Доля успеха из трёх баров принимает\n' +
        '  четыре значения, и калибровка по ней измеряет границы корзин.\n' +
        '  Число остаётся — оно настоящее, это расстояние до уровня в единицах\n' +
        '  ATR, — но называть его уверенностью рано: чтобы это было утверждением,\n' +
        '  нужно примерно в десять раз больше сигналов, чем есть.\n',
);
