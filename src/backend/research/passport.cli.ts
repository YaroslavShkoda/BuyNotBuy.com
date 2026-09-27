import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CANDIDATE_STRATEGIES, fromModule, runStrategy } from './strategies.js';
import { walkForwardStrategy } from './strategy-walk-forward.js';
import { createStrategyRuleRepository } from '../strategies/candidate.repository.js';
import { holdoutStatus, HOLDOUT_COMMITTED_AT, HOLDOUT_MINIMUM_BARS } from './holdout.js';
import { EXECUTION_CONFIG } from '../backtest/execution.js';
import { STRATEGY_FACTORIES } from '../strategies/registry.js';
import { strategySetFingerprint } from '../strategies/strategy-fingerprint.js';
import { hashValue } from '../config/strategy-fingerprint.js';
import { closePool } from '../db/pool.js';

import type { Candle } from '../types/market.js';
import type { StrategyModule } from '../strategies/types.js';

/**
 * Everything that is known about a rule, in one place, dated.
 *
 * A strategy is a set of claims: what it is, where it came from, what it
 * measured, and what later measurement did to it. Those four things have
 * existed in this project only as the sequence of commits that produced them,
 * and a commit log is a poor place to look a thing up and a worse place to
 * look a number up. So they are assembled here from the artefacts themselves —
 * the modules are the modules running in production, the walk-forward is run
 * now rather than quoted, the history is read from the table — and the one
 * thing that cannot be measured is dated and marked as a commitment.
 *
 * What this is not: a recommendation. Nothing here promotes anything. The
 * machine of states is read, not advanced.
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

interface Passport {
    readonly key: string;
    readonly mechanism: string;
    readonly warmup: number;
    readonly installed: boolean;
    readonly fullSample: string;
    readonly profitFactor: string;
    readonly walkForward: string;
    readonly worstFold: string;
    readonly stage: string;
    readonly history: string;
}

const modules: readonly StrategyModule[] = Object.values(STRATEGY_FACTORIES).map(
    (factory) => factory(),
);

const rules = createStrategyRuleRepository();

const passports: Passport[] = [];

for (const module of modules) {
    const strategy = fromModule(module.key, module);
    const full = runStrategy(strategy, daily, { barsPerYear: 365 });
    const forward = walkForwardStrategy(strategy, daily, {
        foldBars: 250,
        barsPerYear: 365,
    });
    const history = await rules.history(module.key);
    const current = await rules.current(module.key);

    passports.push({
        key: module.key,
        mechanism: module.mechanism,
        warmup: module.warmup,
        installed: true,
        fullSample: pct(full.metrics.totalReturn),
        profitFactor:
            full.metrics.profitFactor === null
                ? '—'
                : full.metrics.profitFactor.toFixed(3),
        walkForward: `${(forward.profitableShare * 100).toFixed(0)}% складок`,
        worstFold: pct(forward.worstFold),
        stage: current?.stage ?? 'не зарегистрировано',
        history:
            history.length === 0
                ? 'нет ни одного перехода'
                : history.map((row) => row.stage).join(' → '),
    });
}

console.log('='.repeat(100));
console.log('ПАСПОРТ ПРОИСХОЖДЕНИЯ — что известно о каждом правилу на сегодня');
console.log('='.repeat(100));
console.log(
    `Данные: ${daily.length} дневных баров BTCUSDT, комиссия ${(EXECUTION_CONFIG.takerFeeRate * 100).toFixed(3)}% за сторону, ` +
    `модель исполнения ${EXECUTION_CONFIG.model}, складка 250 баров.`,
);
console.log(
    `Установлено правил: ${JSON.stringify(strategySetFingerprint())} — это то, что попадает в отпечаток конфигурации.\n`,
);

for (const passport of passports) {
    console.log('-'.repeat(100));
    console.log(`  ${passport.key}   прогрев ${passport.warmup} баров`);
    console.log(`  механизм: ${passport.mechanism}`);
    console.log(
        `  на всей истории: ${passport.fullSample}, PF ${passport.profitFactor}`,
    );
    console.log(
        `  walk-forward:    ${passport.walkForward}, худшая складка ${passport.worstFold}`,
    );
    console.log(
        `  этап: ${passport.stage}   история: ${passport.history}`,
    );
}

console.log('\n' + '='.repeat(100));
console.log('ЧТО ЭТО ЗА ПРЕТЕНЗИЯ И ЧТО ОНА НЕ ЗА');
console.log('='.repeat(100));

for (const module of modules) {
    const strategy = fromModule(module.key, module);
    const forward = walkForwardStrategy(strategy, daily, {
        foldBars: 250,
        barsPerYear: 365,
    });

    console.log(`  ${module.key}`);
    console.log(`    ${forward.reason}`);
}

// The bench rules that have no module cannot appear in a passport, which is
// itself worth saying: they are not running, so they are not rules this
// project holds.
console.log('\nСтендовые правила без модуля (не являются правилами этого проекта):');
console.log(
    `  ${CANDIDATE_STRATEGIES.filter(
        (candidate) => !modules.some((module) => module.key === candidate.name),
    )
        .map((candidate) => candidate.name)
        .join(', ')}`,
);

const status = holdoutStatus(daily, []);
console.log('\n' + '='.repeat(100));
console.log('ОКНО, КОТОРОЕ ЕЩЁ НЕ ОТКРЫВАЛИ');
console.log('='.repeat(100));
console.log(
    `  Принято: ${new Date(HOLDOUT_COMMITTED_AT).toISOString().slice(0, 10)}, ` +
    `нужно ${HOLDOUT_MINIMUM_BARS} баров, есть ${status.barsAvailable}.`,
);
console.log(`  ${status.message}`);
console.log(
    '  До этого числа любая оценка правил на этой истории — пересказ того же,\n' +
    '  что уже было сказано выше, в другой формулировке.',
);

console.log('\nОтпечатки для регистрации на held-out окно:');
for (const module of modules) {
    // Of the rule, not of its name. Hashing the key would produce a different
    // value for a rule whose mechanism and parameters had been edited, which
    // is precisely the change the registration is supposed to catch.
    console.log(
        `  ${module.key.padEnd(24)} ${hashValue({
            mechanism: module.mechanism,
            warmup: module.warmup,
        }).slice(0, 16)}…`,
    );
}

await closePool().catch(() => undefined);
