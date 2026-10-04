import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXECUTION_CONFIG } from '../backtest/execution.js';
import { closePool } from '../db/pool.js';
import type { Candle } from '../types/market.js';

import type { Decision, Strategy } from './strategies.js';
import { buildSeries, runStrategy } from './strategies.js';

/**
 * Which leg of the chosen rule actually earns the money.
 *
 * `donchian-trend-gated` is two ideas welded together: a twenty-bar breakout
 * decides *when to enter*, and a volatility test decides *whether that entry
 * counts*. A rule like that is easy to admire and hard to trust, because when
 * it stops working nobody knows which half to look at.
 *
 * So it is taken apart. The obvious ablation — remove the gate, remove the
 * breakout — is not enough on its own, because the gate also makes the rule
 * trade far less often, and trading less is worth something on its own: fewer
 * round trips means less of the cost model paid per year. Any filter that cuts
 * the trade count gets that for free, and it is the most common way a
 * "validated improvement" turns out to be a smaller position.
 *
 * The control that settles it is the **inverted gate**: the same breakout, the
 * same frequency it produces, but entered precisely when the volatility test
 * says *do not*. If the inverted version is anywhere near the real one, the
 * gate is not an edge at all — it is a trade-count reducer wearing a
 * volatility test as a disguise, and the honest description of the strategy is
 * "hold a small position some of the time".
 *
 * The last variant goes further and removes the logic entirely: long on a fixed
 * schedule tuned to match the gated rule's trade count. It has no breakout, no
 * volatility test and no opinion about the market. If it matches, none of the
 * above is a strategy.
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

const at = (series: readonly number[], index: number): number =>
    series[index] ?? NaN;

const ready = (...values: number[]): boolean =>
    values.every((value) => Number.isFinite(value));

/** A plain breakout, before anything is done to it. */
function breakout(context: {
    candles: readonly Candle[];
    index: number;
    series: Readonly<Record<string, readonly number[]>>;
}): Decision {
    const { candles, index, series } = context;
    const previousHigh = at(series['high20p1']!, index);
    const previousLow = at(series['low20p1']!, index);

    if (!ready(previousHigh, previousLow)) {
        return 0;
    }

    if (candles[index]!.close > previousHigh) {
        return 1;
    }

    return candles[index]!.close < previousLow ? -1 : 0;
}

function volatilityIsHigh(context: {
    index: number;
    series: Readonly<Record<string, readonly number[]>>;
}): boolean {
    const atr = at(context.series['atr']!, context.index);
    const slow = at(context.series['atrSlow']!, context.index);

    return ready(atr, slow) && atr > slow;
}

const VARIANTS: { name: string; note: string; rule: Strategy }[] = [
    {
        name: 'A. полное правило (пробой + гейт)',
        note: 'выбранная стратегия целиком',
        rule: {
            name: 'gated',
            mechanism: 'breakout and volatility test',
            warmup: 60,
            decide: (context) => {
                if (!volatilityIsHigh(context)) {
                    return 0;
                }

                return breakout(context);
            },
        },
    },
    {
        name: 'B. только пробой, гейт снят',
        note: 'что остаётся без фильтра',
        rule: {
            name: 'ungated',
            mechanism: 'breakout alone',
            warmup: 60,
            decide: breakout,
        },
    },
    {
        name: 'C. ПРОБОЙ С ИНВЕРТИРОВАННЫМ ГЕЙТОМ',
        note: 'контроль: вход именно тогда, когда гейт запрещает',
            rule: {
            name: 'inverted',
            mechanism: 'breakout gated the wrong way round',
            warmup: 60,
            decide: (context) => {
                if (volatilityIsHigh(context)) {
                    return 0;
                }

                return breakout(context);
            },
        },
    },
    {
        name: 'D. только гейт, без пробоя',
        note: 'просто быть в лонге, когда волатильность высока',
        rule: {
            name: 'gate-only',
            mechanism: 'long whenever the volatility test is true',
            warmup: 60,
            decide: (context) => (volatilityIsHigh(context) ? 1 : 0),
        },
    },
    {
        name: 'E. фиксированное расписание, без логики',
        note: 'лонг в 1 бар из 8 — столько же сделок, ноль решений',
        rule: {
            name: 'calendar',
            mechanism: 'no breakout, no volatility test, a fixed calendar',
            warmup: 60,
            decide: (context) => (context.index % 8 === 0 ? 1 : 0),
        },
    },
];

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

function tableFor(candles: Candle[]): Record<string, unknown>[] {
    return VARIANTS.map((variant) => {
        const run = runStrategy(variant.rule, candles, { barsPerYear: 365 });

        return {
            'вариант': variant.name,
            'что это': variant.note,
            'сделок': run.metrics.trades,
            'доля в рынке': pct(run.metrics.exposure),
            'итог': pct(run.metrics.totalReturn),
            'просадка': pct(run.metrics.maxDrawdown),
            'профит-фактор':
                run.metrics.profitFactor === null
                    ? '—'
                    : run.metrics.profitFactor.toFixed(3),
            'ср. сделка': pct(run.metrics.averageTrade),
            'Sharpe': run.metrics.sharpeRatio.toFixed(2),
        };
    });
}

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

const daily = loadDaily();
const half = Math.floor(daily.length / 2);
const bear = worstWindow(daily, 365);
const bearFrom = new Date(bear[0]!.timestamp).toISOString().slice(0, 10);
const bearTo = new Date(bear[bear.length - 1]!.timestamp).toISOString().slice(0, 10);

const slices: { label: string; candles: Candle[] }[] = [
    { label: 'ВЕСЬ ПЕРИОД 2018—2026', candles: daily },
    { label: 'ПЕРВАЯ ПОЛОВИНА 2018—2022', candles: daily.slice(0, half) },
    { label: 'ВТОРАЯ ПОЛОВИНА 2022—2026', candles: daily.slice(half) },
    { label: `ХУДШИЙ ГОД ${bearFrom}—${bearTo}`, candles: bear },
];

console.log(
    `Разбор выбранного правила. Издержки: ${EXECUTION_CONFIG.liquidity}, ` +
        `комиссия ${pct(EXECUTION_CONFIG.takerFeeRate)}, спред ${pct(EXECUTION_CONFIG.spreadRate)}, ` +
        `проскальзывание ${pct(EXECUTION_CONFIG.slippageRate)}, исполнение ${EXECUTION_CONFIG.model}`,
);

for (const slice of slices) {
    console.log(`\n${'#'.repeat(104)}`);
    console.log(`# ${slice.label}: ${slice.candles.length} баров`);
    console.log('#'.repeat(104));
    console.table(tableFor(slice.candles));
}

// How many breakouts the gate actually keeps, and what it is worth.
const series = buildSeries(daily);
let breakouts = 0;
let kept = 0;

for (let index = 60; index < daily.length; index += 1) {
    if (breakout({ candles: daily, index, series }) === 0) {
        continue;
    }

    breakouts += 1;

    if (
        Number.isFinite(series['atr']![index]!) &&
        Number.isFinite(series['atrSlow']![index]!) &&
        series['atr']![index]! > series['atrSlow']![index]!
    ) {
        kept += 1;
    }
}

console.log(`\nПробоев за весь период: ${breakouts}, гейт пропустил ${kept} (${pct(kept / breakouts)})`);

const atr = series['atr']!;
const slow = series['atrSlow']!;
let highBars = 0;
let considered = 0;

for (let index = 60; index < daily.length; index += 1) {
    if (Number.isFinite(atr[index]!) && Number.isFinite(slow[index]!)) {
        considered += 1;

        if (atr[index]! > slow[index]!) {
            highBars += 1;
        }
    }
}

console.log(
    `Волатильность выше своей средней в ${pct(highBars / considered)} баров — гейт пропускает ${pct(highBars / considered)} времени, а пробой на них срабатывает в ${pct(kept / breakouts)} случаев.`,
);

await closePool().catch(() => undefined);
