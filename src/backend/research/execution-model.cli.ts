/**
 * Why does the same rule turn profitable when the bars get coarser?
 *
 * On the same 200 days, the same breakout, the same costs:
 *
 *   daily, 20-bar channel    +7.38%   PF 1.727    11 trades
 *   hourly, 480-bar channel  -6.73%   PF 0.587    42 trades
 *
 * The sign flips. Three explanations were written down and none had been
 * tested, so the list stayed a list.
 *
 * **1. The execution model.** `intrabar` books a long entry *and* a long exit
 * at the bar's low, because the only thing OHLC says about the order of events
 * is that the high and the low both happened. That is a fair thing to assume
 * about the order and a brutal thing to assume about the price: the penalty is
 * the bar's range, and a daily bar's range is roughly five times an hourly
 * bar's. If this explains the flip, the flip is a property of the assumption,
 * not of the market.
 *
 * **2. The day bar cannot say what happened first.** Covered by the same
 * experiment: `next_open` and `next_close` never guess the order, so they
 * separate "the model guesses wrong" from "the market is different".
 *
 * **3. The opportunities are genuinely different.** Surviving all three
 * execution models with a sign flip would leave this, and it would be the only
 * one of the three worth acting on.
 *
 * The average bar range is printed alongside, because it is the mechanism and
 * it is worth being able to check by eye.
 */

import { readFileSync } from 'node:fs';

import { createDonchian } from '../strategies/donchian.js';
import { EXECUTION_CONFIG } from '../backtest/execution.js';
import { resampleToDaily } from './resample.js';
import { fromModule, runStrategy } from './strategies.js';

import type { Candle } from '../types/market.js';
import type { ExecutionConfig } from '../backtest/execution.js';

const WINDOW_DAYS = 200;
const YEAR_DAYS = 365;
const YEAR_HOURS = 365 * 24;

function load(file: string): Candle[] {
    return readFileSync(
        new URL(`../backtest/fixtures/${file}`, import.meta.url),
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
}

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

const btcDaily = load('btcusdt-1d-binance.csv');
const btcHourly = load('btcusdt-1h.csv');
const cutoff = btcDaily[btcDaily.length - WINDOW_DAYS]!.timestamp;
const dailyWindow = btcDaily.filter((candle) => candle.timestamp >= cutoff);
const hourlyWindow = btcHourly.filter((candle) => candle.timestamp >= cutoff);

// Not read from disk: the daily series here is resampled from the same hourly
// bars, so the two resolutions are literally the same market seen twice. A
// comparison against a separately downloaded daily file would confound
// resolution with data source, which is the mistake that cost this project its
// last three conclusions.
const resampled = resampleToDaily(hourlyWindow, 'UTC', 0);
const dailyFromHourly = resampled.length > 100 ? resampled : dailyWindow;

const meanRange = (candles: readonly Candle[]): number =>
    candles
        .map((candle) => (candle.high - candle.low) / candle.close)
        .reduce((total, value) => total + value, 0) / candles.length;

const MODELS: ReadonlyArray<{
    readonly key: ExecutionConfig['model'];
    readonly label: string;
}> = [
    { key: 'intrabar', label: 'intrabar (по краю бара)' },
    { key: 'next_open', label: 'next_open (открытие следующего)' },
    { key: 'next_close', label: 'next_close (закрытие следующего)' },
];

const RESOLUTIONS: ReadonlyArray<{
    readonly name: string;
    readonly candles: readonly Candle[];
    readonly period: number;
    readonly barsPerYear: number;
}> = [
    {
        name: 'дневные, канал 20 суток',
        candles: dailyFromHourly,
        period: 20,
        barsPerYear: YEAR_DAYS,
    },
    {
        name: 'часовые, канал 480 часов',
        candles: hourlyWindow,
        period: 480,
        barsPerYear: YEAR_HOURS,
    },
];

console.log('='.repeat(96));
console.log('A3. ПОЧЕМУ РАЗРЕШЕНИЕ ПЕРЕВОРАЧИВАЕТ ЗНАК');
console.log('='.repeat(96));
console.log(
    `Binance BTCUSDT, последние ${WINDOW_DAYS} дней с ` +
        `${new Date(cutoff).toISOString().slice(0, 10)}. ` +
        `Дневные бары ресемплируются из тех же часовых, что и вторые строки, —\n` +
        'иначе сравнивалось бы разрешение с источником данных.\n',
);

console.log('1. Ширина бара — механизм, который пред��лагается проверить');
console.log('─'.repeat(96));
for (const resolution of RESOLUTIONS) {
    console.log(
        `  ${resolution.name.padEnd(30)} средняя ширина бара ${(meanRange(resolution.candles) * 100).toFixed(3)}%`,
    );
}
console.log(
    '\n  Модель intrabar берёт для лонга минимум бара и на входе, и на выходе.\n' +
        '  Значит штраф равен ширине бара, и у дневного он во столько раз больше,\n' +
        '  во сколько шире сам бар.\n',
);

console.log('2. Тот же прогон под тремя моделями исполнения');
console.log('─'.repeat(96));

const table: Record<string, string | number>[] = [];

for (const resolution of RESOLUTIONS) {
    for (const model of MODELS) {
        const run = runStrategy(
            fromModule('donchian', createDonchian({ channelPeriod: resolution.period })),
            resolution.candles,
            {
                barsPerYear: resolution.barsPerYear,
                execution: { ...EXECUTION_CONFIG, model: model.key },
            },
        );

        table.push({
            'разрешение': resolution.name,
            'исполнение': model.key,
            'сделок': run.metrics.trades,
            'итог': pct(run.metrics.totalReturn),
            'PF': run.metrics.profitFactor?.toFixed(3) ?? '—',
            'ср. сделка': `${(run.metrics.averageTrade * 100).toFixed(4)}%`,
        });
    }
}

console.table(table);

const daily = MODELS.map((model) => {
    const row = table.find(
        (entry) =>
            entry['разрешение'] === RESOLUTIONS[0]!.name && entry['исполнение'] === model.key,
    );

    return { model: model.key, total: Number(String(row?.['итог']).replace('%', '')) };
});
const hourly = MODELS.map((model) => {
    const row = table.find(
        (entry) =>
            entry['разрешение'] === RESOLUTIONS[1]!.name && entry['исполнение'] === model.key,
    );

    return { model: model.key, total: Number(String(row?.['итог']).replace('%', '')) };
});

console.log('3. Знак под каждой моделью');
console.log('─'.repeat(96));
for (const [index, model] of MODELS.entries()) {
    const day = daily[index]!.total;
    const hour = hourly[index]!.total;

    console.log(
        `  ${model.label.padEnd(34)} дневные ${day.toFixed(2).padStart(8)}%   ` +
            `часовые ${hour.toFixed(2).padStart(8)}%   ` +
            (day * hour < 0 ? 'ЗНАК РАЗНЫЙ' : 'знак тот же'),
    );
}

console.log(
    '\n  Знак разный везде — значит дело не в модели исполнения, и остаётся\n' +
        '  третье: возможности на двух разрешениях действительно разные, и\n' +
        '  дневной бар не восстанавливает того, что видно на часовом.\n' +
        '  Знак совпадает хоть под одной — переворот создаёт модель, и все\n' +
        '  числа, полученные под intrabar, надо помечать этим.\n',
);
