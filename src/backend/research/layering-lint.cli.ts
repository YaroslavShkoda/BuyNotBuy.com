/**
 * PHASE 46, second half, run as a program.
 *
 *   node --env-file=.env --import=tsx src/backend/research/layering-lint.cli.ts
 *
 * Exits non-zero while a file outside the data layer reaches into it, so it can
 * be a gate rather than a report.
 */

import { dirname, resolve } from 'node:path';

import { fileURLToPath } from 'node:url';
import { audit, DATA_LAYER, DATABASE_ACCESSORS } from './layering-lint.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const report = audit(root);

console.log('='.repeat(92));
console.log('M2. ЧТО ПРИКАСАЕТСЯ БАЗЫ И ЖИВЁТ НЕ ТАМ, ГДЕ ДОЛЖНО');
console.log('='.repeat(92));
console.log(
    '  Проверяется не папка, а импорт. Доменный код, который пишет SQL,\n' +
        '  тестируется только с живой базой: правило, изменившееся в нём, и его\n' +
        '  тесты доказывают одно и то же — что база работает. Перенос файла из\n' +
        '  папки в папку этого не меняет: вызывающий всё равно импортирует\n' +
        '  реализацию, и ребро «домен → слой данных» остаётся.\n',
);
console.log(
    `  Файлов разобрано: ${report.files}\n` +
        `    тронувших базу вне «${DATA_LAYER}/»: ${new Set(report.offences.map((o) => o.file)).size}\n` +
        `    из них исключено поимённо:            ${report.exempt.length}\n`,
);

console.log(`  Считается обращением к базе: ${DATABASE_ACCESSORS.join(', ')}\n`);

if (report.offences.length > 0) {
    console.log('  НАРУШЕНИЯ:\n');
    for (const offence of report.offences) {
        console.log(`    ${offence.file}:${offence.line}  ${offence.symbol}`);
    }
    console.log(
        '\n  Пока это так, правило «домен не ходит в базу» написано в документе\n' +
            '  и не может быть включено. Список запинен тестом: он падает не\n' +
            '  молча, а при каждом переносе, и уменьшается видимой правкой.\n',
    );
} else {
    console.log('  Нарушений нет: за пределами слоя данных никто не трогает базу.\n');
}

if (report.exempt.length > 0) {
    console.log('  ИСКЛЮЧЕНИЯ — поимённо и с причиной:\n');
    for (const entry of report.exempt) {
        console.log(`    ${entry.file}`);
        console.log(`      ${entry.reason}\n`);
    }
    console.log(
        '  Исключение, перечисленное файлом, и исключение, спрятанное в шаблоне, —\n' +
            '  разные вещи: первое видно в этом отчёте, второе живёт до того, как\n' +
            '  кто-нибудь его найдёт.\n',
    );
}

console.log('='.repeat(92));
process.exitCode = report.offences.length === 0 ? 0 : 1;
