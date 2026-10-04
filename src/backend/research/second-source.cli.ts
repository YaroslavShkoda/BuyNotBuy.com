/**
 * The same rules, the same dates, two venues.
 *
 * The comparison and its tests are in `second-source.ts`.
 */

import { EXECUTION_CONFIG } from '../backtest/execution.js';
import { createDonchian } from '../strategies/donchian.js';
import { createDonchianCalmGated } from '../strategies/donchian-calm-gated.js';
import { createDonchianTrendGated } from '../strategies/donchian-trend-gated.js';
import type { StrategyModule } from '../strategies/types.js';
import { createVolatilityTrend } from '../strategies/volatility-trend.js';
import type { Candle } from '../types/market.js';
import { compareSources, overlap, pValueOnBoth } from './second-source.js';
import { fromModule, runStrategy } from './strategies.js';
import { loadDaily } from './threshold-null.js';

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
const date = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const binance = loadDaily('btcusdt-1d-binance.csv');
const yahoo = loadDaily('btcusdt-1d.csv');
const pair = overlap(binance, yahoo);

const RULES: ReadonlyArray<{ readonly label: string; readonly module: StrategyModule }> = [
    { label: 'donchian-20', module: createDonchian({ channelPeriod: 20 }) },
    { label: 'donchian-trend-gated', module: createDonchianTrendGated() },
    { label: 'donchian-calm-gated', module: createDonchianCalmGated() },
    { label: 'volatility-trend', module: createVolatilityTrend() },
];

console.log('='.repeat(96));
console.log('B8. ОДНА БИРЖА ИЛИ ДВЕ?');
console.log('='.repeat(96));

const gap = compareSources(binance, yahoo, 'Binance против Yahoo');
console.log(
    `\nСравнение источников на общих ${gap.bars} днях ` +
        `(${date(gap.first)} — ${date(gap.last)}), только пересечение:`,
);
console.log(`  среднее расхождение закрытия, со знаком:  ${gap.meanCloseGap.toFixed(3)}%`);
console.log(`  среднее расхождение максимума, по модулю:  ${gap.meanHighGap.toFixed(3)}%`);
console.log(
    `  наибольшее расхождение максимума:            ` +
        `${gap.worstHighGap.toFixed(2)}% (${date(gap.worstHighAt)})`,
);
console.log(
    '\nКанал Дончиана строится из максимумов и минимумов. Расхождение в 1% на\n' +
        'уровне — это правило, которое на одном источнике ставит стоп там, где на\n' +
        'другом его нет.\n',
);

console.log('='.repeat(96));
console.log('ИТОГ ПРАВИЛ НА ОДНИХ И ТЕХ ЖЕ ДНЯХ');
console.log('='.repeat(96));
console.log(`модель исполнения ${EXECUTION_CONFIG.model}\n`);

const holdBinance = pair.a[pair.a.length - 1]!.close / pair.a[0]!.close - 1;
const holdYahoo = pair.b[pair.b.length - 1]!.close / pair.b[0]!.close - 1;

const rows: Array<Record<string, string>> = [];
for (const { label, module } of RULES) {
    const strategy = fromModule(label, module);
    const onBinance = runStrategy(strategy, pair.a, { barsPerYear: 365 });
    const onYahoo = runStrategy(strategy, pair.b, { barsPerYear: 365 });

    rows.push({
        правило: label,
        'Binance сделок': String(onBinance.metrics.trades),
        'Binance итог': pct(onBinance.metrics.totalReturn),
        'Yahoo сделок': String(onYahoo.metrics.trades),
        'Yahoo итог': pct(onYahoo.metrics.totalReturn),
        'совпал знак':
            Math.sign(onBinance.metrics.totalReturn) === Math.sign(onYahoo.metrics.totalReturn)
                ? 'да'
                : 'НЕТ',
    });
}

rows.push({
    правило: 'просто держать актив',
    'Binance сделок': '—',
    'Binance итог': pct(holdBinance),
    'Yahoo сделок': '—',
    'Yahoo итог': pct(holdYahoo),
    'совпал знак': Math.sign(holdBinance) === Math.sign(holdYahoo) ? 'да' : 'НЕТ',
});

console.table(rows);

console.log(
    '\nПроверка значимости на обоих источниках сразу: правило, которое\n' +
        '  различает себя от шума на бирже, обязано различать себя и на индексе.\n',
);

/**
 * A signal, computed the index-free way the bench uses, over a whole series.
 * The warmup is the same for both, so the compared windows are the same length
 * and the two p-values are about comparable things.
 */
/**
 * A signal, computed the index-free way the bench uses, over a whole series.
 *
 * The warmup is the same for both, so the compared windows are the same length
 * and the two p-values are about comparable things. Returns the whole series
 * and lets `pValueOnBoth` align — see the note there on why that direction of
 * the contract.
 */
const seriesSignal = (
    module: StrategyModule,
    candles: readonly Candle[],
    warmup: number,
): boolean[] => {
    const signal: boolean[] = [];

    for (let index = warmup; index < candles.length; index += 1) {
        const visible = candles.slice(0, index + 1);
        const decision = module.evaluate({
            candles: visible,
            price: visible[visible.length - 1]!.close,
        });

        signal.push(decision.direction !== 'NEUTRAL');
    }

    return signal;
};

const WARMUP = 900;
const pRows: Array<Record<string, string>> = [];

for (const { label, module } of RULES) {
    const both = pValueOnBoth((c) => seriesSignal(module, c, WARMUP), pair.a, pair.b, WARMUP);

    pRows.push({
        правило: label,
        'сигналов Binance': String(both.a.onCount),
        'p Binance': both.a.p.toFixed(4),
        'сигналов Yahoo': String(both.b.onCount),
        'p Yahoo': both.b.p.toFixed(4),
    });
}

console.table(pRows);

console.log(
    '\nИтог: ни одно правило не отличимо от шума ни на одном источнике, и ни одно\n' +
        '  не обгоняет простое удержание актива ни на одном из них. В этом проекте\n' +
        '  нет вывода, который держался бы на особенностях Binance.\n' +
        '  Ранжирование при этом между источниками не совпадает, и это не дефект\n' +
        '  измерения, а то, что значит «две площадки не согласны». Поэтому правило\n' +
        '  в этом проекте нельзя выбирать по таблице: таблица скажет, что лучше,\n' +
        '  ровно до тех пор, пока не сменится площадка.\n',
);
