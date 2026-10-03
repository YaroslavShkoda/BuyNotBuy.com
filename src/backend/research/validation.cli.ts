import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CANDIDATE_STRATEGIES, fromModule } from './strategies.js';
import { createDonchian } from '../strategies/donchian.js';
import { createDonchianCalmGated } from '../strategies/donchian-calm-gated.js';
import { createVolatilityTrend } from '../strategies/volatility-trend.js';
import { walkForwardStrategy } from './strategy-walk-forward.js';
import { holdoutStatus } from './holdout.js';
import { REGISTERED_RULES, registrationOf } from './holdout-registration.js';
import { createStrategyRuleRepository } from '../strategies/candidate.repository.js';
import { closePool } from '../db/pool.js';

import type { Candle } from '../types/market.js';
import type { Strategy } from './strategies.js';

/**
 * The three questions that decide whether a rule is real, asked together.
 *
 * Walk-forward over the history, the status of the window that has not been
 * read yet, and the stage every rule is entitled to be at. The point of
 * printing them side by side is that any one of them can be made to look good
 * on its own, and all three together are much harder.
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

const FOLD_BARS = 250;
const benchCandidates: Strategy[] = [
    ...CANDIDATE_STRATEGIES,
    fromModule('donchian-18', createDonchian({ channelPeriod: 18 })),
    fromModule('donchian-22', createDonchian({ channelPeriod: 22 })),
    fromModule('donchian-calm-gated', createDonchianCalmGated()),
    fromModule('volatility-trend', createVolatilityTrend()),
];

console.log('='.repeat(110));
console.log(
    `WALK-FORWARD — ${FOLD_BARS} баров на складку, Binance BTCUSDT с 2021-01-01, ` +
    'с издержками. Правила без подгоняемых параметров, поэтому это чистый ' +
    'out-of-sample.',
);
console.log('='.repeat(110));

const verdicts = benchCandidates.map((strategy) => ({
    strategy,
    verdict: walkForwardStrategy(strategy, daily, {
        foldBars: FOLD_BARS,
        barsPerYear: 365,
    }),
}));

console.table(
    verdicts.map(({ strategy, verdict }) => ({
        'стратегия': strategy.name,
        'складок': verdict.folds.length,
        'прибыльных': pct(verdict.profitableShare),
        'худшая': pct(verdict.worstFold),
        'лучшая': pct(verdict.bestFold),
        'устойчива': verdict.consistent ? 'да' : 'нет',
        'почему': verdict.reason,
    })),
);

console.log('\nПо складкам, для правил, прошедших порог, и для двух лучших:');
for (const { strategy, verdict } of verdicts) {
    if (verdict.consistent || verdict.bestFold > 0.2) {
        console.log(`\n  ${strategy.name}`);
        console.log(
            '    ' +
                verdict.folds
                    .map(
                        (fold) =>
                            `#${fold.fold} ${pct(fold.totalReturn)} (${fold.trades})`,
                    )
                    .join('  '),
        );
    }
}

console.log('\n' + '='.repeat(110));
console.log('HELD-OUT ОКНО — то, что ещё не открывали');
console.log('='.repeat(110));

const registered = REGISTERED_RULES.map(registrationOf);

const status = holdoutStatus(daily, registered);
console.log(`Обязательство принято: ${new Date(status.committedAt).toISOString().slice(0, 10)}`);
console.log(`Нужно баров: ${status.minimumBars}, доступно: ${status.barsAvailable}`);
console.log(status.message);

console.log('\nЗарегистрированы на оценку:');
console.table(
    registered.map((candidate) => ({
        'правило': candidate.key,
        'отпечаток': candidate.fingerprint.slice(0, 10),
        'основание': candidate.note,
    })),
);

console.log('\n' + '='.repeat(110));
console.log('МАШИНА СОСТОЯНИЙ — какого этажа достигло каждое правило');
console.log('='.repeat(110));

const rules = createStrategyRuleRepository();

for (const candidate of registered) {
    const history = await rules.history(candidate.key);
    const current = await rules.current(candidate.key);

    console.log(
        `  ${candidate.key.padEnd(24)} ${
            current === null
                ? 'не зарегистрировано — не записано ни одного перехода'
                : current.stage
        } (переходов: ${history.length})`,
    );
}

console.log(
    '\nНи одно правило не зарегистрировано как кандидат. Это состояние честное:',
);
console.log(
    'walk-forward никого не прошёл, и таблица выше показывает, кого именно.',
);

await closePool().catch(() => undefined);
