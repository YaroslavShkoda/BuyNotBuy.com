/**
 * What the bench costs, at four sizes, and what the warmup skip saved.
 *
 * The measurement is in `bench-cost.ts`.
 */

import { createDonchian } from '../strategies/donchian.js';
import type { Timing } from './bench-cost.js';
import { extrapolate, growthRatio, loadHourly, timeRun } from './bench-cost.js';
import { fromModule, runStrategy } from './strategies.js';

const SIZES = [1000, 2000, 4000, 8000];
const hourly = loadHourly('btcusdt-1h.csv');

console.log('='.repeat(96));
console.log('C3. СКОЛЬКО СТОИТ СТЕНД И ЧТО С НИМ МОЖНО СДЕЛАТЬ');
console.log('='.repeat(96));
console.log(
    `donchian-20, часовые бары Binance, всего в фикстуре ${hourly.length}.\n` +
        'Контракт модуля не имеет индекса, поэтому каждый вызов пересобирает\n' +
        'всю видимую историю: N вызовов по N баров.\n',
);

const timings: Timing[] = SIZES.map((bars) =>
    timeRun(bars, () => {
        runStrategy(
            fromModule('donchian-20', createDonchian({ channelPeriod: 20 })),
            hourly.slice(0, bars),
            { barsPerYear: 365 * 24 },
        );
    }),
);

console.log('  баров        всего, мс     на бар, мс    рост на бар');
console.log('  ─────────────────────────────────────────────────────');
timings.forEach((timing, index) => {
    const growth = index === 0 ? '—' : `×${growthRatio(timings[index - 1]!, timing).toFixed(2)}`;

    console.log(
        `  ${String(timing.bars).padStart(5)}   ${timing.ms.toFixed(0).padStart(12)}   ` +
            `${timing.msPerBar.toFixed(3).padStart(10)}   ${growth.padStart(10)}`,
    );
});

const perBar = growthRatio(timings[timings.length - 2]!, timings[timings.length - 1]!);
// `perBar` is the cost *per bar* between two runs, so the exponent on total
// time is one higher. Reading it as the exponent makes an O(n^2) bench look
// like O(n^1.2), which is the sort of flattering miscount this file exists to
// stop.
const power = 1 + Math.log2(perBar);

console.log(
    `\n  Рост на бар при удвоении: ×${perBar.toFixed(2)}, ` +
        `то есть степень n^${power.toFixed(2)} для полного времени.\n` +
        `  Линейно было бы ×1.00 на бар (n^1.00), квадратично — ×2.00 (n^2.00).\n`,
);

const last = timings[timings.length - 1]!;
const projected = extrapolate(last, hourly.length, power);

console.log('  ' + '─'.repeat(52));
console.log(
    `  По измеренному закону весь фид (${hourly.length} баров) — это ` +
        `${projected.toFixed(0)} секунд\n` +
        `  на одно правило. Девять длин канала на восемь складок — ` +
        `в семьдесят раз больше.`,
);

console.log('\n  что из этого убирается, а что нет');
console.log('  ─────────────────────────────────────────────────────');

const withSkip = timeRun(2000, () => {
    runStrategy(
        fromModule('donchian-20', createDonchian({ channelPeriod: 20 })),
        hourly.slice(0, 2000),
        { barsPerYear: 365 * 24 },
    );
});
const withoutSkip = timeRun(2000, () => {
    // The same work with the warmup skip bypassed, by asking for a module
    // that claims no warmup — which is what the adapter used to do for every
    // bar regardless of what the module said.
    const module = createDonchian({ channelPeriod: 20 });
    const strategy = fromModule('donchian-20', { ...module, warmup: 0 });

    runStrategy(strategy, hourly.slice(0, 2000), { barsPerYear: 365 * 24 });
});

console.log(
    `  2000 баров, тёплый модуль пропускается: ${withSkip.ms.toFixed(0)} мс\n` +
        `  2000 баров, вызов на каждом баре:       ${withoutSkip.ms.toFixed(0)} мс\n` +
        `  экономия: ${(100 - (withSkip.ms / withoutSkip.ms) * 100).toFixed(0)}%\n` +
        `  при том, что пропускается 900 вызовов из 2000 — то есть 45% вызовов\n` +
        `  и почти ноль времени. Стоимость распределена крайне неравномерно:\n` +
        `  ранние бары дешёвы, потому что видна короткая история, а дороги\n` +
        `  последние. Пропуск убирает ровно те вызовы, которые ничего не стоили.\n`,
);

console.log('  ' + '='.repeat(52));
console.log(
    '  Квадратичную часть убрать нельзя, и это не долг, а цена.\n' +
        '  Линейный стенд означает индекс или окно в контракте модуля, а то и\n' +
        '  другое позволяет спросить значение на баре, который не последний —\n' +
        '  ровно та дырка, которую нынешняя форма закрывает. Ускорить стенд,\n' +
        '  сделав утечку выразимой, значит заплатить единственным, что этот\n' +
        '  проект вообще продаёт.\n' +
        '  Убирается работа над вопросами, на которые уже отвечает module.warmup.\n' +
        '  Остальное — измерение, чтобы никто больше не угадывал стоимость прогона.\n',
);
