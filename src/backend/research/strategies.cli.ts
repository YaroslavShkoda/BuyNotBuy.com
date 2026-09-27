import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CANDIDATE_STRATEGIES, runStrategy } from './strategies.js';
import { EXECUTION_CONFIG } from '../backtest/execution.js';
import { runWalkForward, DEFAULT_WALK_FORWARD_OPTIONS } from '../backtest/walk-forward.js';
import { query, closePool } from '../db/pool.js';

import type { Candle } from '../types/market.js';

/**
 * The strategy bench.
 *
 * Prints every candidate, not the best one, and then prints them all again over
 * five different slices of the same history. The first table says what a rule
 * did; the second says whether it did it everywhere or only where it was
 * looked at. The gap between those two questions is the whole difference
 * between a strategy and a coincidence, and a single whole-sample table cannot
 * tell them apart — the rule that won the first table was chosen by the first
 * table, so re-running it there is circular.
 */

const CSV = fileURLToPath(
    new URL('../backtest/fixtures/btcusdt-1d-binance.csv', import.meta.url),
);

function loadDaily(): Candle[] {
    const lines = readFileSync(CSV, 'utf8')
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0);

    return lines.slice(1).map((line) => {
        const [timestamp, open, high, low, close, volume] = line.split(',');

        return {
            timestamp: Number(timestamp),
            open: Number(open),
            high: Number(high),
            low: Number(low),
            close: Number(close),
            volume: Number(volume),
        };
    });
}

async function loadLiveHourly(): Promise<Candle[]> {
    const { rows } = await query<Record<string, string>>(
        `
        SELECT timestamp, open, high, low, close, volume
          FROM market_candles
         WHERE symbol = $1 AND interval = $2
         ORDER BY timestamp
    `,
        [
            process.env['MARKET_SYMBOL'] ?? 'BTCUSDT',
            process.env['MARKET_CANDLE_INTERVAL'] ?? '1h',
        ],
    );

    return rows.map((row) => ({
        timestamp: Number(row['timestamp']),
        open: Number(row['open']),
        high: Number(row['high']),
        low: Number(row['low']),
        close: Number(row['close']),
        volume: Number(row['volume']),
    }));
}

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

function tableFor(candles: Candle[], barsPerYear: number): Record<string, unknown>[] {
    return CANDIDATE_STRATEGIES.map((strategy) => {
        const run = runStrategy(strategy, candles, { barsPerYear });

        return {
            'стратегия': strategy.name,
            'сделок': run.metrics.trades,
            'доля в рынке': pct(run.metrics.exposure),
            'итог': pct(run.metrics.totalReturn),
            'просадка': pct(run.metrics.maxDrawdown),
            'просадка, бары': run.metrics.maxDrawdownBars,
            'винрейт': pct(run.metrics.winRate),
            'профит-фактор':
                run.metrics.profitFactor === null
                    ? '—'
                    : run.metrics.profitFactor.toFixed(3),
            'ср. сделка': pct(run.metrics.averageTrade),
            'Sharpe': run.metrics.sharpeRatio.toFixed(2),
            'buy&hold': pct(run.benchmarks.buyAndHold),
            'случайный': pct(run.benchmarks.randomEntry),
        };
    });
}

const daily = loadDaily();

/**
 * The worst year in the data, found rather than remembered.
 *
 * An earlier version of this file labelled the 2018—2020 slice "bearish".
 * Buy and hold made 485% in it. A long-biased rule looks wonderful in a
 * market that went up five times, and calling that a stress test would have
 * been the most misleading line in the report. So the slice that matters is
 * located by measurement: the worst 365-bar window, which is where every rule
 * that is mostly long has to prove it can be wrong.
 */
function worstWindow(candles: Candle[], bars: number): Candle[] {
    let worst = { from: 0, move: 0 };

    for (let from = 0; from + bars <= candles.length; from += 1) {
        const move =
            candles[from + bars - 1]!.close / candles[from]!.close - 1;

        if (move < worst.move) {
            worst = { from, move };
        }
    }

    return candles.slice(worst.from, worst.from + bars);
}

const bear = worstWindow(daily, 365);
const bearFrom = new Date(bear[0]!.timestamp).toISOString().slice(0, 10);
const bearTo = new Date(bear[bear.length - 1]!.timestamp).toISOString().slice(0, 10);

const half = Math.floor(daily.length / 2);

const slices: { label: string; candles: Candle[] }[] = [
    { label: 'ВЕСЬ ПЕРИОД 2018—2026', candles: daily },
    { label: 'ПЕРВАЯ ПОЛОВИНА 2018—2022', candles: daily.slice(0, half) },
    { label: 'ВТОРАЯ ПОЛОВИНА 2022—2026', candles: daily.slice(half) },
    {
        label: `ХУДШИЙ ГОД ${bearFrom}—${bearTo}`,
        candles: bear,
    },
    { label: 'ПОСЛЕДНИЕ 900 БАРОВ', candles: daily.slice(-900) },
];

console.log('='.repeat(100));
console.log(
    `Издержки: ${EXECUTION_CONFIG.liquidity}, комиссия ${pct(EXECUTION_CONFIG.takerFeeRate)}, ` +
        `спред ${pct(EXECUTION_CONFIG.spreadRate)}, ` +
        `проскальзывание ${pct(EXECUTION_CONFIG.slippageRate)}, ` +
        `исполнение ${EXECUTION_CONFIG.model}`,
);
console.log('='.repeat(100));

for (const slice of slices) {
    const first = new Date(slice.candles[0]!.timestamp).toISOString().slice(0, 10);
    const last = new Date(
        slice.candles[slice.candles.length - 1]!.timestamp,
    )
        .toISOString()
        .slice(0, 10);

    console.log(`\n${'#'.repeat(100)}`);
    console.log(
        `# ${slice.label}: ${slice.candles.length} баров, ${first} — ${last}`,
    );
    console.log('#'.repeat(100));
    console.table(tableFor(slice.candles, 365));
}

console.log(`\n${'='.repeat(100)}`);
console.log('Штатная стратегия проекта, walk-forward, для сравнения:');
console.log('='.repeat(100));

try {
    const wf = runWalkForward(daily, {
        ...DEFAULT_WALK_FORWARD_OPTIONS,
        maxFolds: 10,
    });

    console.log(
        `  сделок ${wf.trades.length}, итог ${pct(wf.overall.totalReturn)}, ` +
            `просадка ${pct(wf.overall.maxDrawdown)}, ` +
            `Sharpe ${wf.overall.sharpeRatio.toFixed(2)}`,
    );
    console.log(
        `  против buy&hold: ${
            wf.excessOverBuyAndHold === null ? '—' : pct(wf.excessOverBuyAndHold)
        }, складок принято ${
            wf.folds.filter((fold) => fold.validation.accepted).length
        } из ${wf.folds.length}`,
    );
} catch (error) {
    console.log('  walk-forward не выполнен:', (error as Error).message);
}

try {
    const hourly = await loadLiveHourly();

    if (hourly.length > 300) {
        console.log(`\n${'#'.repeat(100)}`);
        console.log(`# ЖИВАЯ БАЗА BTCUSDT 1h: ${hourly.length} баров`);
        console.log('#'.repeat(100));
        console.table(tableFor(hourly, 365 * 24));
    } else {
        console.log(
            `\nЖивая база: всего ${hourly.length} баров 1h — пока рано для сравнения.`,
        );
    }
} catch (error) {
    console.log('\nЖивая база недоступна:', (error as Error).message);
}

await closePool();
