import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CANDIDATE_STRATEGIES, runStrategy } from './strategies.js';
import { EXECUTION_CONFIG } from '../backtest/execution.js';
import { createDonchian, DONCHIAN_CONFIG } from '../strategies/donchian.js';
import { fromModule } from './strategies.js';
import { query, closePool } from '../db/pool.js';

import type { Candle } from '../types/market.js';
import type { ExecutionConfig } from '../backtest/execution.js';

/**
 * The two questions a backtest result has to survive before it means anything.
 *
 * A rule that works at exactly the parameter it was chosen at is not a rule, it
 * is a point — the number a grid landed on, and everything around it worse.
 * So the first table here walks the parameter one step at a time and asks
 * whether the neighbours hold up. This is deliberately *not* a search: the
 * point is the shape of the surface, and a grid that picked its own best cell
 * would be selection bias wearing the clothes of a robustness check.
 *
 * The second question is what the rule is worth once it has to actually be
 * traded. `donchian-20` takes a few hundred round trips, and each one pays the
 * full cost model twice. At some fee level the edge is gone no matter how good
 * the signal is, and the useful number is where that is.
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

const daily = loadDaily();
const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

console.log('='.repeat(104));
console.log('1. УСТОЙЧИВОСТЬ К ПАРАМЕТРУ — работает ли правило или точка');
console.log('='.repeat(104));
console.log(
    'Канал пробоя на соседних длинах. Правило выбрано на 20 барах; если соседи',
);
console.log(
    'разваливаются, то 20 — это результат перебора, а не свойство рынка.\n',
);
console.log(
    'Binance BTCUSDT, 2096 дневных баров с 2021-01-01. На старой фикстуре ' +
        'Yahoo поверх\nбыл плато с 20 у края; здесь он острый пик — а это ' +
        'заметно хуже.\n',
);

const periods = [14, 16, 18, 20, 22, 24, 28, 35, 55];
const surface = periods.map((channelPeriod) => {
    const run = runStrategy(
        fromModule(`donchian-${channelPeriod}`, createDonchian({ channelPeriod })),
        daily,
        { barsPerYear: 365 },
    );

    return {
        'длина канала': channelPeriod,
        'сделок': run.metrics.trades,
        'итог': pct(run.metrics.totalReturn),
        'просадка': pct(run.metrics.maxDrawdown),
        'профит-фактор':
            run.metrics.profitFactor === null
                ? '—'
                : run.metrics.profitFactor.toFixed(3),
        'Sharpe': run.metrics.sharpeRatio.toFixed(2),
        'доля в рынке': pct(run.metrics.exposure),
    };
});

console.table(surface);

const profitable = surface.filter(
    (row) => !row['итог'].startsWith('-') && Number(row['профит-фактор']) > 1,
).length;
console.log(
    `Прибыльных длин: ${profitable} из ${periods.length}. ` +
    `Выбранная длина 20 — это максимум, нет — устойчивость, одна — точка.\n`,
);

console.log('='.repeat(104));
console.log('2. ЧУВСТВИТЕЛЬНОСТЬ К ИЗДЕРЖКАМ — при какой комиссии правило перестаёт работать');
console.log('='.repeat(104));
console.log(
    'Та же стратегия, та же история, меняется только цена сделки. Стартовые',
);
console.log(
    '0.10% — типичная комиссия для базовой пары биржи.\n',
);

const costRows = [0, 0.0005, 0.001, 0.002, 0.003, 0.005, 0.008, 0.012].map(
    (takerFeeRate) => {
        const config: ExecutionConfig = {
            ...EXECUTION_CONFIG,
            takerFeeRate,
        };
        const run = runStrategy(
            fromModule('donchian-20', createDonchian()),
            daily,
            { barsPerYear: 365, execution: config },
        );

        return {
            'комиссия за сторону': pct(takerFeeRate),
            'за круг': pct(takerFeeRate * 2 + EXECUTION_CONFIG.spreadRate + EXECUTION_CONFIG.slippageRate),
            'сделок': run.metrics.trades,
            'итог': pct(run.metrics.totalReturn),
            'профит-фактор':
                run.metrics.profitFactor === null
                    ? '—'
                    : run.metrics.profitFactor.toFixed(3),
            'просадка': pct(run.metrics.maxDrawdown),
        };
    },
);

console.table(costRows);

const breakeven = costRows.find((row) => row['итог'].startsWith('-'));

console.log(
    breakeven === undefined
        ? 'Правило прибыльно при любой из перебранных комиссий.'
        : `Перелом проходит между ${pct(
              Number(costRows[costRows.indexOf(breakeven) - 1]?.['комиссия за сторону']?.replace('%', '') ?? 0) / 100,
          )} и ${breakeven['комиссия за сторону']} за сторону.`,
);

console.log(`\nКонфигурация по умолчанию: канал ${DONCHIAN_CONFIG.channelPeriod} баров.`);
console.log(
    `Всего кандидатов в стенде: ${CANDIDATE_STRATEGIES.length}. Для сравнения их результаты на полном периоде:`,
);

console.table(
    CANDIDATE_STRATEGIES.map((strategy) => {
        const run = runStrategy(strategy, daily, { barsPerYear: 365 });

        return {
            'стратегия': strategy.name,
            'итог': pct(run.metrics.totalReturn),
            'сделок': run.metrics.trades,
        };
    }),
);

try {
    const live = await query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM market_candles WHERE interval = '1h'",
    );
    console.log(
        `\nЧасовых баров в живой базе: ${live.rows[0]?.count}. ` +
        'Этого недостаточно, чтобы повторить проверку на исполнении 1h — см. шаг про сбор баров.',
    );
} catch {
    console.log('\nЖивая база недоступна.');
}

await closePool().catch(() => undefined);
