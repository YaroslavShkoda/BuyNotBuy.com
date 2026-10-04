/**
 * Prints what the walk-forward bar says about rules that know nothing.
 *
 * The measurement lives in `threshold-null.ts` and is tested there. This file is
 * only the report, so that the number can be checked without reading the table.
 */

import { EXECUTION_CONFIG } from '../backtest/execution.js';
import { createDonchian } from '../strategies/donchian.js';
import { createVolatilityTrend } from '../strategies/volatility-trend.js';
import { fromModule } from './strategies.js';
import { walkForwardStrategy } from './strategy-walk-forward.js';
import {
    clears,
    DEFAULT_EXPOSURE,
    DEFAULT_FOLD_BARS,
    DEFAULT_RULES,
    DEFAULT_SEED,
    loadDaily,
    measurePassRates,
} from './threshold-null.js';

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const btc = loadDaily('btcusdt-1d-binance.csv');

console.log('='.repeat(96));
console.log('B5. ЧТО ПОР WALK-FORWARD ГОВОРИТ ПРАВИЛАМ, КОТОРЫЕ НИЧЕГО НЕ ЗНАЮТ');
console.log('='.repeat(96));
console.log(
    `Binance BTCUSDT, ${btc.length} дневных баров, складки по ${DEFAULT_FOLD_BARS}, ` +
        `модель исполнения ${EXECUTION_CONFIG.model}.\n` +
        `Случайные лонг-сигналы, доля в рынке ${pct(DEFAULT_EXPOSURE)}, ` +
        `${DEFAULT_RULES} правил, сид ${DEFAULT_SEED}.\n`,
);

const rates = measurePassRates(btc);

console.log('  доля случайных правил, проходящих пор');
console.log('  ────────────────────────────────────────');
console.log(`  ≥50% складок прибыльны и худшая > 0:   ${pct(rates.atHalf)}`);
console.log(
    `  ≥60% складок прибыльны и худшая > 0:   ${pct(rates.atSixty)}   ← нынешний порог`,
);
console.log(`  ≥70% складок прибыльны и худшая > 0:   ${pct(rates.atSeventy)}`);
console.log(`\n  а по половинам порога:`);
console.log(`  только доля складок ≥60%:              ${pct(rates.shareOnly)}`);
console.log(`  только худшая складка > 0:            ${pct(rates.worstOnly)}`);
console.log(`\n  складок на прогон: ${rates.folds}, сделок у самого удачливого: ${rates.mostTrades}`);
console.log(
    `  лучший результат среди случайных: ${pct(rates.bestProfitableShare)} складок, ` +
        `худшая складка ${pct(rates.bestWorstFold)}`,
);

console.log('\n  настоящие правила под тем же порогом');
console.log('  ────────────────────────────────────────');
for (const [label, strategy] of [
    ['donchian-20', fromModule('donchian-20', createDonchian({ channelPeriod: 20 }))],
    ['volatility-trend', fromModule('volatility-trend', createVolatilityTrend())],
] as const) {
    const verdict = walkForwardStrategy(strategy, btc, {
        foldBars: DEFAULT_FOLD_BARS,
        barsPerYear: 365,
    });

    console.log(
        `  ${label.padEnd(20)} ${pct(verdict.profitableShare).padStart(6)} складок, ` +
            `худшая ${pct(verdict.worstFold).padStart(9)}  ` +
            `${clears(verdict, 0.6) ? 'ПРОШЁЛ' : 'нет'}`,
    );
}

console.log(
    '\n  Ни одно из четырёхсот случайных правил не прошло, и разбиение показывает\n' +
        '  почему: долю складок ≥60% монетка набирает обычно, и лучшее из них\n' +
        '  взяло 75%. Непроходимо условие «худшая складка > 0» — а оно в коде\n' +
        '  ничем не обосновано и лонговому правилу с издержками недостижимо по\n' +
        '  построению: комиссия и ненулевое время в рынке гарантируют хотя бы\n' +
        '  одно убыточное окно. Значит «ничего не прошло walk-forward» говорило\n' +
        '  не о правилах, а об арифметике комиссии.\n' +
        '  Ослаблять порог на том основании, что первая его половина дешёвая,\n' +
        '  нельзя: условие, которое проходит монетка, не может быть условием\n' +
        '  прохождения. Нужен настоящий критерий — проверка значимости против\n' +
        '  этих же монет, — и он в signal-power.ts уже есть.\n',
);
