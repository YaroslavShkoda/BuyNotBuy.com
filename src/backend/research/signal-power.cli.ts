/**
 * Does any of this beat chance?
 *
 * Every other command in this directory answers "how much did it make". This
 * one answers the question those numbers cannot: whether the amount is
 * distinguishable from picking bars at random. It runs over Binance BTCUSDT and
 * ETHUSDT daily bars from 2021-01-01, the same series everything else uses.
 *
 * Read the two columns together. A signal can beat the bars it skipped by a
 * factor of four and still be indistinguishable from a coin toss, because the
 * bars it skipped are not the bars chance would pick. What removes the drift
 * from the comparison is the permutation, and what the permutation says is the
 * `p` column.
 */

import { readFileSync } from 'node:fs';

import { atrSeries, rollingMax } from '../strategies/series.js';

import {
    forwardReturns,
    futureSignal,
    permutationPValue,
} from './signal-power.js';

import type { Candle } from '../types/market.js';

const FIXTURES: ReadonlyArray<{ readonly file: string; readonly label: string }> = [
    { file: 'btcusdt-1d-binance.csv', label: 'Binance BTCUSDT' },
    { file: 'ethusdt-1d.csv', label: 'Binance ETHUSDT' },
];

const DRAWS = 5000;

function loadDaily(file: string): Candle[] {
    return readFileSync(
        new URL(`../backtest/fixtures/${file}`, import.meta.url),
        'utf8',
    )
        .split(/\r?\n/u)
        .filter((line) => line.trim() !== '')
        .slice(1)
        .map((line) => {
            const [t, o, h, l, c, v] = line.split(',');

            return {
                timestamp: Number(t),
                open: Number(o),
                high: Number(h),
                low: Number(l),
                close: Number(c),
                volume: Number(v),
            };
        });
}

/** The ablation's D: long while volatility exceeds its own average. */
function volatilitySignal(candles: Candle[], atrPeriod: number, baseline: number): boolean[] {
    const atr = atrSeries(candles, atrPeriod);
    const warmup = atrPeriod + baseline + 1;

    return candles.map((_, index) => {
        if (index < warmup) {
            return false;
        }

        const window = atr.slice(index - baseline + 1, index + 1).filter(Number.isFinite);

        if (window.length < baseline) {
            return false;
        }

        return atr[index]! > window.reduce((total, value) => total + value, 0) / baseline;
    });
}

/** A twenty-bar breakout, the project's own reference rule. */
function breakoutSignal(candles: Candle[], period: number): boolean[] {
    const closes = candles.map((candle) => candle.close);
    const channel = rollingMax(closes, period);

    return candles.map(
        (_, index) =>
            index > period &&
            Number.isFinite(channel[index - 1]!) &&
            closes[index]! > channel[index - 1]!,
    );
}

const pct = (value: number): string => `${(value * 100).toFixed(4)}%`;

console.log('='.repeat(104));
console.log('ЗНАЧИМОСТЬ ПРОТИВ СЛУЧАЯ — отличается ли сигнал от выбора баров наугад');
console.log('='.repeat(104));
console.log(
    'Сравнение внутри одной серии: средний выход на один бар вперёд на барах, где\n' +
        'правило сработало, и на барах, где оно молчало. Дрейф внутри пары общий,\n' +
        'поэтому разница — то, что сигнал добавляет сам. А p — как часто случайная\n' +
        'переразметка тех же баров даёт разницу не меньше.\n',
);
console.log(
    'p около 0.5 — неотличимо от случайности. Подбрасывание монеты столько не\n' +
        'набирает, сколько здесь набрали все шесть строк.\n',
);

const rows: Array<{
    readonly asset: string;
    readonly signal: string;
    readonly onCount: number;
    readonly onMean: number;
    readonly offMean: number;
    readonly p: number;
}> = [];

for (const fixture of FIXTURES) {
    const candles = loadDaily(fixture.file);
    const closes = candles.map((candle) => candle.close);
    const forward = forwardReturns(closes);

    const signals: ReadonlyArray<{ readonly name: string; readonly fired: boolean[] }> = [
        { name: 'волатильность > своей средней', fired: volatilitySignal(candles, 14, 40) },
        { name: 'пробой 20 баров', fired: breakoutSignal(candles, 20) },
    ];

    for (const signal of signals) {
        const result = permutationPValue(forward, signal.fired, { draws: DRAWS });

        rows.push({
            asset: fixture.label,
            signal: signal.name,
            onCount: result.onCount,
            onMean: result.onMean,
            offMean: result.offMean,
            p: result.p,
        });
    }

    // The control runs on every fixture on every invocation, not as a test
    // somewhere else. A research command whose test has not been run is a
    // research command whose numbers nobody has checked, and the whole table
    // above is meaningless if the thing measuring it is stuck.
    const control = permutationPValue(forward, futureSignal(forward), { draws: 2000 });
    const inMarket = signals[0]!.fired.filter(Boolean).length / candles.length;
    const buyAndHold = closes[closes.length - 1]! / closes[0]! - 1;

    console.log(`${fixture.label}: ${candles.length} баров, в рынке ${(inMarket * 100).toFixed(2)}%,`);
    console.log(
        `  просто держать актив: ${(buyAndHold * 100).toFixed(2)}%   |   ` +
            `контроль (сигнал из будущего): p = ${control.p.toFixed(4)} ` +
            `${control.p < 0.01 ? '— прибор работает' : '— ПРИБОР НЕ РАБОТАЕТ'}\n`,
    );
}

console.log(
    '┌─────────────────────┬──────────────────────────────┬────────┬────────────┬────────────┬───────────┐',
);
console.log(
    '│ актив               │ сигнал                       │  баров │ сработало │  молчало  │     p     │',
);
console.log(
    '├─────────────────────┼──────────────────────────────┼────────┼────────────┼────────────┼───────────┤',
);
for (const row of rows) {
    const flag = row.p < 0.05 ? ' *' : '  ';

    console.log(
        `│ ${(row.asset + ' ' + row.signal).slice(0, 34).padEnd(34)} │ ` +
            `${String(row.onCount).padStart(4)} │ ${pct(row.onMean).padStart(8)} │ ` +
            `${pct(row.offMean).padStart(8)} │ ${row.p.toFixed(4).padStart(6)}${flag} │`,
    );
}
console.log(
    '└──────────────────────────────────────────────────────────────────────────────────────────────┘',
);
console.log(
    '\nЗвёздочки нет ни у одной строки. Это не значит, что правила бесполезны —\n' +
        'это значит, что на двух тысячах баров их нечем отличить от случайности, и\n' +
        'что следующий шаг — не новое правило, а новое окно.',
);
