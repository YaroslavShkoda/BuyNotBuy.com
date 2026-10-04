import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXECUTION_CONFIG } from '../backtest/execution.js';
import { createDonchian } from '../strategies/donchian.js';
import { createDonchianCalmGated } from '../strategies/donchian-calm-gated.js';
import { createDonchianTrendGated } from '../strategies/donchian-trend-gated.js';
import type { Candle } from '../types/market.js';
import { resampleToDaily } from './resample.js';
import { CANDIDATE_STRATEGIES, fromModule, runStrategy } from './strategies.js';
import { walkForwardStrategy } from './strategy-walk-forward.js';

/**
 * Two questions, on the data the system actually trades.
 *
 * **Does the resolution change the answer?** A daily bar cannot say whether its
 * high came before its low, so a rule that trades inside a bar has to guess.
 * Hourly bars can. If the guess was doing the work, the same rule measured on
 * hourly bars will differ — and the size of the difference is the size of the
 * guess. That is worth knowing before any of these numbers is believed, and it
 * is only knowable on a series verified to be the same market, which is what
 * `fixtures/README.md` is about.
 *
 * **Does the finding survive being about something else?** Everything measured
 * so far is one asset, one exchange feed's counterpart, and one regime. A rule
 * that only works on bitcoin is a fact about bitcoin. ETH is the cheapest
 * available test of the claim "this is a rule" as opposed to "this is a rule on
 * BTCUSDT", and it is not the strongest test available — a second exchange
 * would be stronger, and a second regime would be stronger still.
 *
 * Both questions are asked here on Binance data, because the previous twenty
 * steps were asked on Yahoo BTC-USD and the two are not the same series.
 */

const FIXTURES = fileURLToPath(new URL('../backtest/fixtures/', import.meta.url));

function load(name: string): Candle[] {
    const lines = readFileSync(`${FIXTURES}${name}`, 'utf8')
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

const btcHourly = load('btcusdt-1h.csv');
const btcDaily = load('btcusdt-1d-binance.csv');
const ethDaily = load('ethusdt-1d.csv');

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
const YEAR_HOURS = 365 * 24;
const YEAR_DAYS = 365;

const rule = {
    btc: {
        bare: fromModule('donchian-20', createDonchian()),
        calm: fromModule('donchian-calm-gated', createDonchianCalmGated()),
        gated: fromModule('donchian-trend-gated', createDonchianTrendGated()),
    },
    eth: CANDIDATE_STRATEGIES,
};

console.log('='.repeat(96));
console.log('ИСПОЛНЕНИЕ НА ЧАСОВЫХ ПРОТИВ ДНЕВНЫХ — один и тот же рынок, два разрешения');
console.log('='.repeat(96));
console.log(
    `Часовых баров: ${btcHourly.length}, дневных: ${btcDaily.length}, ` +
        `из них построено из часовых: ${resampleToDaily(btcHourly, 'UTC').length}.`,
);
console.log(
    `Издержки: комиссия ${(EXECUTION_CONFIG.takerFeeRate * 100).toFixed(3)}% за сторону, ` +
        `проскальзывание ${(EXECUTION_CONFIG.slippageRate * 100).toFixed(3)}%, ` +
        `спред ${(EXECUTION_CONFIG.spreadRate * 100).toFixed(3)}%, за круг ` +
        `${((EXECUTION_CONFIG.takerFeeRate * 2 + EXECUTION_CONFIG.slippageRate + EXECUTION_CONFIG.spreadRate) * 100).toFixed(3)}%.`,
);
console.log(
    'Число сделок НЕ сравнивается напрямую: за год часовых баров в 24 раза\n' +
        'больше, чем дневных, и правило на двадцати барах означает двадцать\n' +
        'часов против двадцати суток. Это разные правила, и сравнивать их\n' +
        'исходы — значит сравнивать разные вопросы.\n',
);

// To make the comparison a fair one, the hourly rule is asked about the same
// span of *time* as the daily rule: 20 hourly bars is one day, so the hourly
// variant uses a 20-hour channel to cover what the daily variant covers with a
// 20-day channel, and a 480-hour channel to cover the same twenty days.
//
// The window is the same for every resolution, because a comparison between
// two spans is not a comparison. It is short, and the reason is measured: the
// bench adapter hands a strategy module only the bars it is allowed to see,
// and every module walks that slice several times, so a run over N bars is
// quadratic. Fifty thousand hourly bars did not finish in ten minutes. Two
// hundred days does, and the question here — does the resolution change the
// answer — is answerable in a window long enough to hold a few hundred trades.
const WINDOW_DAYS = 200;
const cutoff = btcDaily[btcDaily.length - WINDOW_DAYS]!.timestamp;

const btcDailyWindow = btcDaily.filter((candle) => candle.timestamp >= cutoff);
const btcHourlyWindow = btcHourly.filter((candle) => candle.timestamp >= cutoff);
const ethDailyWindow = ethDaily.filter((candle) => candle.timestamp >= cutoff);

console.log(
    `Окно сравнения: последние ${WINDOW_DAYS} дней, с ` +
        `${new Date(cutoff).toISOString().slice(0, 10)}. ` +
        `Дневных баров ${btcDailyWindow.length}, часовых ${btcHourlyWindow.length}, ` +
        `дневных ETH ${ethDailyWindow.length}.`,
);

const resolutions: readonly {
    name: string;
    candles: readonly Candle[];
    period: number;
    barsPerYear: number;
}[] = [
    { name: 'дневные, канал 20 суток', candles: btcDailyWindow, period: 20, barsPerYear: YEAR_DAYS },
    { name: 'часовые, канал 480 часов (те же 20 суток)', candles: btcHourlyWindow, period: 480, barsPerYear: YEAR_HOURS },
    { name: 'часовые, канал 20 часов (те же 20 баров)', candles: btcHourlyWindow, period: 20, barsPerYear: YEAR_HOURS },
];

const rows: Record<string, string | number>[] = [];

// One rule, three resolutions. The gated rules have their own questions, and
// answering them here would multiply a quadratic cost by three without making
// the resolution comparison any sharper.
for (const resolution of resolutions) {
    const started = performance.now();
    const run = runStrategy(
        fromModule('donchian', createDonchian({ channelPeriod: resolution.period })),
        resolution.candles,
        { barsPerYear: resolution.barsPerYear },
    );

    rows.push({
        'разрешение': resolution.name,
        'баров': resolution.candles.length,
        'сделок': run.metrics.trades,
        'в год': (
            run.metrics.trades /
            (resolution.candles.length / resolution.barsPerYear)
        ).toFixed(0),
        'итог': pct(run.metrics.totalReturn),
        'просадка': pct(run.metrics.maxDrawdown),
        'PF': run.metrics.profitFactor?.toFixed(3) ?? '—',
        'секунд': ((performance.now() - started) / 1000).toFixed(1),
    });
}

console.table(rows);

console.log(
    'Три строки — это три разных правила, а не три измерения одного.\n' +
    'Канал в 20 часов покрывает сутки, канал в 20 суток — месяц: сравнивать их\n' +
    'исходы без этого замечания значит сравнивать разные вопросы.\n' +
    'Совпадение означало бы, что разрешение неважно; расхождение — что на\n' +
    'дневных барах пришлось угадывать то, что на часовых видно.\n',
);

console.log('='.repeat(96));
console.log('WALK-FORWARD НА ПРАВИЛЬНЫХ ДАННЫХ — Binance BTCUSDT вместо Yahoo BTC-USD');
console.log('='.repeat(96));

const before: string[] = [];
const after: string[] = [];

for (const [label, strategy] of Object.entries(rule.btc)) {
    const forward = walkForwardStrategy(strategy, btcDaily, {
        foldBars: 250,
        barsPerYear: YEAR_DAYS,
    });
    const full = runStrategy(strategy, btcDaily, { barsPerYear: YEAR_DAYS });

    after.push(
        `  ${label.padEnd(22)} ${pct(full.metrics.totalReturn).padStart(9)}  ` +
            `${(forward.profitableShare * 100).toFixed(0).padStart(3)}% складок  ` +
            `худшая ${pct(forward.worstFold).padStart(8)}  ` +
            `${forward.consistent ? 'устойчиво' : 'нет'}`,
    );
}
console.log('Binance BTCUSDT, 2096 дневных баров с 2021-01-01:');
console.log(after.join('\n'));

console.log('\nДля сравнения, Yahoo BTC-USD, 2934 бара с 2018-08-22 (то, на чём');
console.log('измерялись предыдущие шаги):');
for (const [label, strategy] of Object.entries(rule.btc)) {
    before.push(
        `  ${label.padEnd(22)} ${pct(
            runStrategy(strategy, load('btcusdt-1d.csv'), {
                barsPerYear: YEAR_DAYS,
            }).metrics.totalReturn,
        ).padStart(9)}`,
    );
}
console.log(before.join('\n'));

console.log('\n='.repeat(96));
console.log('ВТОРОЙ ИНСТРУМЕНТ — ETHUSDT, та же биржа, те же даты');
console.log('='.repeat(96));

console.log(
    `ETHUSDT, ${ethDaily.length} дневных баров с 2021-01-01 — вся серия, ` +
        'а не окно сравнения выше: дневные бары стоят дёшево, и урезание их до ' +
        '200 дней дало бы walk-forward ноль складок вместо ответа.',
);

const ethRows = rule.eth.map((strategy) => {
    const run = runStrategy(strategy, ethDaily, { barsPerYear: YEAR_DAYS });
    const forward = walkForwardStrategy(strategy, ethDaily, {
        foldBars: 250,
        barsPerYear: YEAR_DAYS,
    });

    return {
        'стратегия': strategy.name,
        'сделок': run.metrics.trades,
        'итог': pct(run.metrics.totalReturn),
        'PF': run.metrics.profitFactor?.toFixed(3) ?? '—',
        'просадка': pct(run.metrics.maxDrawdown),
        'walk-forward': `${(forward.profitableShare * 100).toFixed(0)}% складок`,
        'худшая': pct(forward.worstFold),
        'устойчива': forward.consistent ? 'да' : 'нет',
    };
});

console.table(ethRows);

const btcAndHold = runStrategy(CANDIDATE_STRATEGIES[0]!, btcDaily, {
    barsPerYear: YEAR_DAYS,
});
const ethAndHold = runStrategy(CANDIDATE_STRATEGIES[0]!, ethDaily, {
    barsPerYear: YEAR_DAYS,
});

console.log(
    `За тот же период BTCUSDT: ${pct(btcAndHold.metrics.totalReturn)}, ` +
        `ETHUSDT: ${pct(ethAndHold.metrics.totalReturn)}.`,
);
console.log(
    `Разница между инструментами — ${(Math.abs(btcAndHold.metrics.totalReturn - ethAndHold.metrics.totalReturn) * 100).toFixed(0)} п.п. ` +
        'просто от того, что это разные активы. Ни одно правило не может\n' +
        'показать разброс больше, чем даёт смена одного актива на другой, и\n' +
        'оставаться при этом на одной и той же стороне от нуля.',
);

console.log(
    `\nЧасовых баров в фикстуре всего: ${btcHourly.length}, ` +
        `из них до окна held-out: ` +
        `${btcHourly.filter((candle) => candle.timestamp < Date.UTC(2026, 8, 27)).length}.`,
);
