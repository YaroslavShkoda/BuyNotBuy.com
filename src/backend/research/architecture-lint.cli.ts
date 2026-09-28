/**
 * PHASE 0, run as a program instead of written down.
 *
 *   node --env-file=.env --import=tsx src/backend/research/architecture-lint.cli.ts
 *
 * Exits non-zero while violations remain, so it can be a gate rather than a
 * report. The count that matters is the last one.
 */

import { audit, EXCEPTIONS } from './architecture-lint.js';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const report = audit(root);

console.log('='.repeat(92));
console.log('M0. ГДЕ ПРОГРАММА РЕШАЕТ, НА КАКОМ РЫНКЕ ОНА РАБОТАЕТ');
console.log('='.repeat(92));
console.log(
    '  Разбор исходников компилятором TypeScript, а не поиск по тексту.\n' +
        '  Разница принципиальная: символ в комментарии — это запись измерения,\n' +
        '  и символ в коде — это решение. Регуляркой они неразличимы, и любой\n' +
        '  рукописный список смешивает их ровно так же, как и не находит.\n',
);

console.log(
    `  Всего вхождений символа: ${report.occurrences.length}\n` +
        `    в комментариях (записи измерений):  ${report.documented}\n` +
        `    в коде, разрешённый слой:           ${report.configured}\n` +
        `    в коде, домен:                     ${report.violations.length}\n`,
);

console.log('  Разрешённые слои и почему:');
for (const exception of EXCEPTIONS) {
    console.log(`    ${exception.path.padEnd(12)} ${exception.reason}`);
}

const named = report.occurrences.filter((o) => o.via === 'identifier');

console.log(
    '\n  ' + '='.repeat(88) +
        '\n  ВТОРАЯ ОСЬ. PHASE 0.2 ищет не только литералы, но и имена:\n' +
        '  defaultSymbol, defaultAsset, btcSymbol, BTC_PRICE. Строковым\n' +
        '  литералом их не поймать — это объявления.\n' +
        `\n  Объявлений с рынком в имени: ${named.length}` +
        (named.some((o) => !o.exempted)
            ? ', из них вне разрешённых слоёв:'
            : ', все в разрешённых слоях:') +
        '\n',
);

for (const occurrence of named) {
    console.log(
        `   ${occurrence.exempted ? ' ' : '!'} ${occurrence.file}:${occurrence.line}  ${occurrence.value}`,
    );
}

if (named.every((o) => o.exempted)) {
    console.log(
        '\n  `defaultSymbol` и `defaultAsset`, которые PHASE 0.2 предлагает искать,\n' +
            '  в этом коде отсутствуют — оба. Именованных рынок вне исследовательских\n' +
            '  скриптов, которые так и называют свой предмет, не осталось ни одного.\n' +
            '  Правило остаётся в guard на тот день, когда одно из имён появится:\n' +
            '  аудит, работающий только по одному написанию, это не аудит.\n',
    );
}

console.log('  ' + '='.repeat(88));
if (report.violations.length === 0) {
    console.log('  Нарушений нет: домен нигде не решает, на каком рынке работает.\n');
} else {
    console.log('  НАРУШЕНИЯ — каждое это зашитый рынок в домене:\n');
    for (const violation of report.violations) {
        console.log(`    ${violation.file}:${violation.line}  ${violation.value}`);
    }
    console.log(
        '\n  Каждое из них делает одно и то же: говорит домену, что система\n' +
            '  существует для BTC. Пока они есть, PHASE 1 не начат — не потому,\n' +
            '  что список длинный, а потому, что список сам по себе не мешает\n' +
            '  появиться новому пункту. Он закрыт тестом, а не договорённостью.\n',
    );
}

process.exitCode = report.violations.length === 0 ? 0 : 1;
