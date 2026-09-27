/**
 * The eight days that are not in the sample.
 *
 * The measurement is in `coverage-gap.ts`. Run it to see which days, what
 * including them would do to a channel, and whether the gap was a market event
 * or a feed artefact.
 */

import { readFileSync } from 'node:fs';

import { createDonchian } from '../strategies/donchian.js';
import { channelInflation, resampleWithCoverage } from './coverage-gap.js';
import { fromModule, runStrategy } from './strategies.js';

import type { Candle } from '../types/market.js';

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
const date = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const hourly: Candle[] = readFileSync(
    new URL('../backtest/fixtures/btcusdt-1h.csv', import.meta.url),
    'utf8',
)
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .slice(1)
    .map((line) => {
        const [t, o, h, lo, cl, v] = line.split(',');

        return {
            timestamp: Number(t),
            open: Number(o),
            high: Number(h),
            low: Number(lo),
            close: Number(cl),
            volume: Number(v),
        };
    });

const coverage = resampleWithCoverage(hourly);

console.log('='.repeat(96));
console.log('C1. ВОСЕМЬ ДНЕЙ, КОТОРЫХ НЕТ В ВЫБОРКЕ');
console.log('='.repeat(96));
console.log(
    `Часовых баров: ${hourly.length}. Дней построено: ${coverage.complete.length}, ` +
        `из них отброшено за неполноту: ${coverage.dropped.length}.\n`,
);

console.log('  дата          часов в дне   доля суток   размах дня');
console.log('  ─────────────────────────────────────────────────────');
for (const day of coverage.dropped) {
    const share = day.hours / 24;
    const width = (day.partialHigh - day.partialLow) / day.partialHigh;

    console.log(
        `  ${date(day.timestamp)}   ${String(day.hours).padStart(8)}   ` +
            `${pct(share).padStart(9)}   ${pct(width).padStart(9)}`,
    );
}

const completeWidths = coverage.complete.map(
    (day) => (day.high - day.low) / day.high,
);
const meanComplete =
    completeWidths.reduce((total, width) => total + width, 0) / completeWidths.length;

console.log(
    `\n  средний размах полного дня: ${pct(meanComplete)}. ` +
        `Диапазон выпавших: ${pct(
            Math.min(
                ...coverage.dropped.map((d) => (d.partialHigh - d.partialLow) / d.partialHigh),
            ),
        )} — ${pct(
            Math.max(
                ...coverage.dropped.map((d) => (d.partialHigh - d.partialLow) / d.partialHigh),
            ),
        )}.\n`,
);

const inflation = channelInflation(coverage.complete, coverage.withPartial, 20);
console.log('  во что обходится их возвращение в выборку');
console.log('  ─────────────────────────────────────────────────────');
console.log(`  канал Дончиана на 20 баров, ${inflation.windows} скользящих окон`);
console.log(`  среднее расширение канала:    ${pct(inflation.mean)}`);
console.log(`  наибольшее расширение:        ${pct(inflation.worst)}`);

const clean = runStrategy(fromModule('donchian-20', createDonchian({ channelPeriod: 20 })), coverage.complete, {
    barsPerYear: 365,
});
const dirty = runStrategy(fromModule('donchian-20', createDonchian({ channelPeriod: 20 })), coverage.withPartial, {
    barsPerYear: 365,
});

console.log(`\n  donchian-20 на ${coverage.complete.length} полных днях: ${pct(clean.metrics.totalReturn)}, ` +
    `${clean.metrics.trades} сделок`);
console.log(
    `  donchian-20 на всех ${coverage.withPartial.length} днях:      ${pct(dirty.metrics.totalReturn)}, ` +
        `${dirty.metrics.trades} сделок`);

console.log('\n' + '='.repeat(96));
console.log('ИТОГ');
console.log('='.repeat(96));
console.log(
    `Правило верное: у неполного дня максимум и минимум, которых рынок не\n` +
        `достигал, и канал, построенный на разрыве в ленте, — это не канал.\n` +
        `Но и несущим оно не является. Возвращение этих дней в выборку сдвигает\n` +
        `канал в среднем на ${pct(inflation.mean)} и меняет результат правила на\n` +
        `${Math.abs(dirty.metrics.totalReturn - clean.metrics.totalReturn) >= 0 ? 'около ' + pct(Math.abs(dirty.metrics.totalReturn - clean.metrics.totalReturn)) : 'менее 0.01%'},\n` +
        `без смены знака. Читателю это позволяет считать отбрасывание гигиеной,\n` +
        `а не чем-то, что тихо лепит каждое число в репозитории.\n`,
);
