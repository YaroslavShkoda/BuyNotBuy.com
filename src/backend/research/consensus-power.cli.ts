/**
 * The project's own strategy, measured on the instrument it actually trades.
 *
 * Everything in the last twenty steps compared candidate rules against each
 * other. The rule the dashboard has been recommending all along — the
 * consensus of stochastic, momentum, EMA confirmation, RSI and MACD — was
 * never in those tables on Binance data. It was last measured on the Yahoo
 * fixture that turned out not to be the thing this system trades, and it came
 * out at -63.87% over 478 trades with a Sharpe of -3.05, which is a result
 * worth checking rather than carrying forward.
 *
 * So: the production signal path, on Binance BTCUSDT and ETHUSDT daily bars
 * from 2021-01-01, against the same question `signal-power.cli.ts` asks
 * everything else. A strategy that returns a number is not the same claim as a
 * strategy whose returns can be told apart from choosing bars at random, and
 * this is the only rule in the repository that nobody had subjected to the
 * second question.
 */

import { readFileSync } from 'node:fs';

import { computeSignalSeries } from '../backtest/point-in-time.js';
import { requiredCandleCount } from '../config/indicator.config.js';
import type { Candle } from '../types/market.js';
import { forwardReturns, permutationPValue } from './signal-power.js';

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

const pct = (value: number): string => `${(value * 100).toFixed(4)}%`;

console.log('='.repeat(104));
console.log('СОБСТВЕННАЯ СТРАТЕГИЯ ПРОЕКТА — консенсус на биржевых данных');
console.log('='.repeat(104));
console.log(
    'Тот самый путь, которым пользуется прибор: calculateMarketIndicators по\n' +
        'видимым барам, потом signalFrom. Ничего не переписано для стенда.\n',
);
console.log(
    'Замер — на барах, где консенсус сказал LONG. SHORT отдельно: в лонг-инструменте\n' +
        'он означал бы падение, а в измерении «сигнал против шума» такого бара нет.\n',
);

interface Reading {
    readonly asset: string;
    readonly direction: 'LONG' | 'SHORT';
    readonly bars: number;
    readonly onMean: number;
    readonly offMean: number;
    readonly p: number;
    readonly share: number;
}

const readings: Reading[] = [];

for (const fixture of FIXTURES) {
    const candles = loadDaily(fixture.file);
    const closes = candles.map((candle) => candle.close);

    // The indicator pipeline refuses to answer before its own warmup, and 900
    // bars is what that is. Measured after it rather than padded over: a
    // backtest that starts at the first bar of a series with a 900-bar warmup
    // is a backtest that had to invent its own history.
    const warmup = requiredCandleCount();
    const signals = computeSignalSeries(candles, warmup, candles.length - 2);
    const measurable = signals.length;
    // Forward returns over exactly the bars the signals cover. The length comes
    // from the signal series rather than from a second count of the same
    // arithmetic — off by one here once already, and the guard below caught it
    // instead of quietly comparing 1195 returns against 1195 signals drawn
    // from the end of the series.
    const forward = forwardReturns(closes).slice(warmup, warmup + signals.length);

    for (const direction of ['LONG', 'SHORT'] as const) {
        // `PointInTimeSignal.signal` is the whole result, so the verdict is one
        // level further in than the field name suggests.
        const fired = signals.map((point) => point.signal.signal === direction);
        const any = fired.some(Boolean);

        if (!any) {
            continue;
        }

        const result = permutationPValue(forward, fired, { draws: DRAWS });

        readings.push({
            asset: fixture.label,
            direction,
            bars: result.onCount,
            onMean: result.onMean,
            offMean: result.offMean,
            p: result.p,
            share: result.onCount / measurable,
        });
    }

    const long = signals.filter((point) => point.signal.signal === 'LONG').length;
    const short = signals.filter((point) => point.signal.signal === 'SHORT').length;
    const neutral = signals.length - long - short;

    console.log(
        `${fixture.label}: ${candles.length} баров, прогрев ${warmup}, замерено ${measurable}; ` +
            `из них LONG ${long} (${((long / signals.length) * 100).toFixed(1)}%), ` +
            `SHORT ${short}, NEUTRAL ${neutral}`,
    );
    console.log(
        `  просто держать актив: ${pct(closes[closes.length - 1]! / closes[warmup]! - 1)}\n`,
    );
}

console.log(
    '┌─────────────────────┬──────────┬─────────┬────────────┬────────────┬──────────┐',
);
console.log(
    '│ актив               │ направл. │  доля   │  сработало │  молчало   │     p    │',
);
console.log(
    '├─────────────────────┼──────────┼─────────┼────────────┼────────────┼──────────┤',
);
for (const reading of readings) {
    console.log(
        `│ ${(reading.asset + ' ' + reading.direction).slice(0, 20).padEnd(20)} │ ` +
            `${reading.direction.padEnd(8)} │ ${(reading.share * 100).toFixed(1).padStart(5)}% │ ` +
            `${pct(reading.onMean).padStart(8)} │ ${pct(reading.offMean).padStart(8)} │ ` +
            `${reading.p.toFixed(4).padStart(6)} │`,
    );
}
console.log(
    '└──────────────────────────────────────────────────────────────────────────────┘',
);
