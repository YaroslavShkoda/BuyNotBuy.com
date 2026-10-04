/**
 * Is channel length 20 a property of the market, or the best cell of a grid?
 *
 * The robustness table prints nine lengths side by side. Read as a whole it
 * looks like an answer, and it is not: 55 bars returns +18.81% against 20
 * bars' +15.29%, so 20 is not even the maximum of the surface it is quoted
 * from. That sentence was hardcoded in the output rather than computed, which
 * is the third time in this project a file has asserted something its own
 * measurements contradict.
 *
 * Two things have to be true before 20 means anything, and neither is visible
 * in a table of totals.
 *
 * **It has to win in every fold, not in the total.** A length that is best
 * overall because of one window is a length fitted to that window, and summing
 * over folds hides exactly that. So: every length, every fold, and the winner
 * in each — then, whether any one length keeps winning.
 *
 * **Winning has to be more than a coin.** If nine lengths each win a fold here
 * and there, nothing is being selected at all, and the choice of 20 is a
 * choice. Uniform would be one win each; concentration is what a real
 * parameter looks like. So the win counts are compared against relabelling the
 * lengths within each fold, which keeps every fold's nine numbers and only
 * scrambles which length they belong to.
 *
 * The result on Binance BTCUSDT, 2096 daily bars from 2021-01-01, folds of 250
 * bars: the wins scatter, and the concentration is within what relabelling
 * produces. The surface is flat inside noise. That is also why the rule failing
 * walk-forward was never surprising — a parameter that does not matter and a
 * rule that does not work are the same situation reached from two directions.
 */

import { readFileSync } from 'node:fs';

import { createDonchian } from '../strategies/donchian.js';
import type { Candle } from '../types/market.js';
import { mulberry32 } from './signal-power.js';
import { fromModule } from './strategies.js';
import { walkForwardStrategy } from './strategy-walk-forward.js';

const PERIODS = [14, 16, 18, 20, 22, 24, 28, 35, 55] as const;
const FOLD_BARS = 250;
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

const candles = loadDaily('btcusdt-1d-binance.csv');

/** `grid[period][fold]` — one column per length, one row per fold. */
const grid: number[][] = PERIODS.map((channelPeriod) => {
    const verdict = walkForwardStrategy(
        fromModule(`donchian-${channelPeriod}`, createDonchian({ channelPeriod })),
        candles,
        { foldBars: FOLD_BARS, barsPerYear: 365 },
    );

    return verdict.folds.map((fold) => fold.totalReturn);
});

const foldCount = grid[0]!.length;

console.log('='.repeat(104));
console.log('A2. ДЛИНА 20 — СВОЙСТВО РЫНКА ИЛИ ЛУЧШАЯ ЯЧЕЙКА СЕТКИ');
console.log('='.repeat(104));
console.log(
    `Binance BTCUSDT, ${candles.length} дневных баров с 2021-01-01, складки по ` +
        `${FOLD_BARS} баров, ${foldCount} складок, с издержками.\n`,
);

console.log('1. Итог каждой длины по каждой складке (проценты)');
console.log('─'.repeat(104));
console.log(
    'складка │' + PERIODS.map((length) => String(length).padStart(8)).join('│') + '│ лучший',
);
for (let fold = 0; fold < foldCount; fold += 1) {
    const row = grid.map((column) => {
        const value = column[fold]!;

        return (value * 100).toFixed(1).padStart(7) + '%';
    });
    const best = Math.max(...grid.map((column) => column[fold]!));
    const bestLength = PERIODS[grid.findIndex((column) => column[fold] === best)];

    console.log(
        `${String(fold).padStart(7)} │${row.join('│')}│    ${String(bestLength).padStart(2)}  ${pct(best)}`,
    );
}

const wins = new Array<number>(PERIODS.length).fill(0) as number[];
for (let fold = 0; fold < foldCount; fold += 1) {
    const best = Math.max(...grid.map((column) => column[fold]!));
    const winner = grid.findIndex((column) => column[fold] === best);

    wins[winner] = (wins[winner] ?? 0) + 1;
}

const means = grid.map((column) => column.reduce((a, b) => a + b, 0) / foldCount);
const meanWinner = PERIODS[means.indexOf(Math.max(...means))];

console.log('\n2. Сколько складок выиграла каждая длина');
console.log('─'.repeat(104));
for (const [index, length] of PERIODS.entries()) {
    const bar = '█'.repeat(wins[index]!) + '·'.repeat(foldCount - wins[index]!);

    console.log(
        `  ${String(length).padStart(2)}  ${bar.padEnd(foldCount)}  ` +
            `${String(wins[index]!).padStart(2)} из ${foldCount} складок, ` +
            `среднее ${pct(means[index]!)}`,
    );
}
console.log(
    `\n  Лучшее среднее — длина ${meanWinner}. Выбрана 20.` +
        (meanWinner === 20 ? ' Совпало.' : ' Не совпало: цифра в отчёте была неверной.'),
);

/**
 * Is the concentration of wins more than relabelling produces?
 *
 * Each fold's nine returns are kept exactly as they are; only the label saying
 * which length each belongs to is shuffled, within that fold. Under the null no
 * length is special, so every length should win about one fold, and the
 * statistic is the largest single win count.
 */
const random = mulberry32(31);
const observed = Math.max(...wins);

let atLeastAsExtreme = 0;
const labels = PERIODS.map((_, index) => index);

for (let draw = 0; draw < DRAWS; draw += 1) {
    const relabelled = new Array<number>(PERIODS.length).fill(0) as number[];

    for (let fold = 0; fold < foldCount; fold += 1) {
        // Fisher–Yates on the label list, per fold.
        for (let i = labels.length - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            const held = labels[i]!;
            labels[i] = labels[j]!;
            labels[j] = held;
        }
        relabelled[labels[0]!] = (relabelled[labels[0]!] ?? 0) + 1;
    }

    if (Math.max(...relabelled) >= observed) {
        atLeastAsExtreme += 1;
    }
}

const p = (atLeastAsExtreme + 1) / (DRAWS + 1);

console.log('\n3. Сосредоточены ли победы сильнее, чем при случайной разметке');
console.log('─'.repeat(104));
console.log(
    `  длин ${PERIODS.length}, складок ${foldCount}, при равномерности ожидалось бы ` +
        `≈${(foldCount / PERIODS.length).toFixed(2)} на длину`,
);
console.log(`  наблюдаемый максимум побед: ${observed} у длины ${PERIODS[wins.indexOf(observed)]}`);
console.log(`  p = ${p.toFixed(4)}   (рисуется ${DRAWS} раз)`);
console.log(
    '\n  ' +
        (p < 0.05
            ? 'Концентрация больше шума: длина, которая выигрывает складки, ' +
              'действительно что-то значит.'
            : 'Концентрация не отличима от шума: выбор длины — это выбор, ' +
              'а не находка, и таблица из девяти чисел этого не показывает.'),
);
