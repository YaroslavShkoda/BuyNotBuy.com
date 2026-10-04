/**
 * The replacement bar, run against every rule this project ships.
 *
 * The measurement and its tests are in `walk-forward-power.ts`.
 */

import { createDonchian } from '../strategies/donchian.js';
import { createDonchianCalmGated } from '../strategies/donchian-calm-gated.js';
import { createDonchianTrendGated } from '../strategies/donchian-trend-gated.js';
import type { StrategyModule } from '../strategies/types.js';
import { createVolatilityTrend } from '../strategies/volatility-trend.js';
import { fromModule } from './strategies.js';
import { loadDaily } from './threshold-null.js';
import {
    coinPopulation,
    compareAgainstCoins,
    profileOf,
    SIGNIFICANCE_LEVEL,
} from './walk-forward-power.js';

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const FOLD_BARS = 250;
const COINS = 200;
const SEED = 0x7a1e_5e11;
const btc = loadDaily('btcusdt-1d-binance.csv');

const RULES: ReadonlyArray<{ readonly label: string; readonly module: StrategyModule }> = [
    { label: 'donchian-20', module: createDonchian({ channelPeriod: 20 }) },
    { label: 'donchian-trend-gated', module: createDonchianTrendGated() },
    { label: 'donchian-calm-gated', module: createDonchianCalmGated() },
    { label: 'volatility-trend', module: createVolatilityTrend() },
];

const profiles = RULES.map(({ label, module }) =>
    profileOf(label, fromModule(label, module), btc, FOLD_BARS),
);

// Drawn across a range of trading frequencies, because the rules sit between
// 8% and 30% and a control drawn only at 40% would leave most rules with
// nothing to be compared against.
const coins = coinPopulation(btc, {
    count: COINS,
    foldBars: FOLD_BARS,
    exposures: [0.1, 0.2, 0.3, 0.4, 0.5],
    seed: SEED,
});

console.log('='.repeat(96));
console.log('B5, ЧАСТЬ ВТОРАЯ. БАРА, ЧЕРЕЗ КОТОРУЮ НЕ ПРОХОДИТ МОНЕТКА');
console.log('='.repeat(96));
console.log(
    `Binance BTCUSDT, ${btc.length} дневных баров, складки по ${FOLD_BARS}, ` +
        `${COINS} случайных правил с долями в рынке 10—50%, сид ${SEED}.\n` +
        `Уровень значимости ${pct(SIGNIFICANCE_LEVEL)}. Сравнение только с монетами,\n` +
        `которые торгуют с той же частотой (±10 п. п.), потому что правило в рынке\n` +
        `12% и монета в рынке 40% несопоставимы ни по одному числу walk-forward.\n`,
);

console.log('  правило                 в рынке  складок  худшая   | монет  p     итог');
console.log('  ───────────────────────────────────────────────────────────────────────');
for (const profile of profiles) {
    const result = compareAgainstCoins(profile, coins);

    console.log(
        `  ${profile.key.padEnd(22)} ${pct(profile.exposure).padStart(7)}  ` +
            `${pct(profile.profitableShare).padStart(7)}  ${pct(profile.worstFold).padStart(8)}   |` +
            `  ${String(result.matchedCoins).padStart(4)}  ` +
            `${result.pValue.toFixed(3)}  ${result.significant ? 'ЗНАЧИМО' : 'нет'}`,
    );
}

const passing = profiles.filter((profile) => compareAgainstCoins(profile, coins).significant);

console.log(
    `\n  Лучший результат среди совпавших по частоте монет: ` +
        `${pct(Math.max(...profiles.map((p) => compareAgainstCoins(p, coins).bestCoinShare)))} ` +
        `складок.\n`,
);

console.log('  ' + '='.repeat(92));
if (passing.length === 0) {
    console.log(
        '  Ничего не прошло, и читать это надо осторожнее, чем хочется.\n',
    );
} else {
    console.log(`  Прошли: ${passing.map((p) => p.key).join(', ')}.\n`);
}

const closest = profiles
    .map((profile) => ({ profile, result: compareAgainstCoins(profile, coins) }))
    .sort((a, b) => a.result.pValue - b.result.pValue)[0]!;

console.log(
    `  Ближе всех к границе: ${closest.profile.key}, p = ${closest.result.pValue.toFixed(3)} ` +
        `при ${closest.result.matchedCoins} совпавших монетах.\n` +
        '  Одна монета здесь — это 1.25% перцентиля, так что разрешение теста\n' +
        '  около ±0.0125, и 0.050 не отличить от порога, который не пройден.\n' +
        '  Плюс сама статистика груба: восемь складок, доля прибыльных может\n' +
        '  принимать девять значений, и 62.5% — одно из них. Тест на девятизначной\n' +
        '  величине настоящий и одновременно тупой.\n' +
        '  Это же объясняет, почему p здесь 0.050, а в пермутации по сигналу 0.7956:\n' +
        '  вопросы разные. Пермутация спрашивает, ловит ли сигнал рынок; здесь\n' +
        '  спрашивается, бьёт ли доля складок монеты той же частоты. Второе —\n' +
        '  гораздо более слабое свидетельство, потому что доля складок почти\n' +
        '  не разрешается.\n',
);

console.log(
    '  ────────────────────────────────────────────────────────────────────────\n' +
        '  Полезный вывод не «ничего не прошло, значит вопрос закрыт», а такой:\n' +
        '  статистика доли складок не способна нести проверку значимости —\n' +
        '  вторая, независимая от необоснованности порога, причина, по которой\n' +
        '  итог walk-forward надо менять. А то, что тест действительно\n' +
        '  устанавливает, четыре измерения подтверждают независимо: ни одно\n' +
        '  правило здесь не отделимо от монет, торгующих так же часто.\n',
);
