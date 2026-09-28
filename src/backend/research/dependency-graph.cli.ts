/**
 * M0, the other half: what depends on what, and in which direction.
 *
 *   node --env-file=.env --import=tsx src/backend/research/dependency-graph.cli.ts
 */

import { LAYERS, summarise } from './dependency-graph.js';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const report = summarise(root);
const pad = (value: string, width: number): string => value.padEnd(width);

console.log('='.repeat(92));
console.log('M0. ГРАФ ЗАВИСИМОСТЕЙ И НАПРАВЛЕНИЕ РЁБР');
console.log('='.repeat(92));
console.log(
    `  ${report.files} файлов, ${report.edges} рёбер, из них ${report.internal} внутри слоя.\n` +
        '  Слои объявлены явно, и объявление различает два рода слоёв. Core\n' +
        '  держит решение и импортирует только то, что объявлено. Composition\n' +
        '  собирает: api, services, observability, research, точки входа. Им\n' +
        '  запрещать что-либо собирать значит запрещать им существовать.\n' +
        '  Первая версия этой таблицы взяла цепочку роадмапа за порядок\n' +
        '  зависимостей и объявила api → market нарушением. Это не нарушение —\n' +
        '  это HTTP-адаптер. Цепочка описывает поток данных, а не связи.\n',
);

console.log('  слой              файлов   рёбер наружу   объявленный доступ');
console.log('  ' + '─'.repeat(84));
for (const row of report.byLayer) {
    const declared = LAYERS.find((entry) => entry.name === row.layer);

    if (!declared) {
        continue;
    }

    const access = declared.composition
        ? 'составляющий — всё'
        : (declared.mayImport.join(', ') || 'ничего');

    console.log(
        `  ${pad(row.layer, 16)} ${String(row.files).padStart(6)} ${String(row.edges).padStart(14)}   ${access}`,
    );
}

if (report.unplaced.length > 0) {
    console.log(`\n  Слои вне таблицы: ${report.unplaced.join(', ')}`);
    console.log('  Ранг им не назначен: это решение, а не факт.');
}

console.log('\n  ' + '='.repeat(88));
console.log('  Рёбра, которых объявление не разрешает:');
if (report.violations.length === 0) {
    console.log('    нет');
} else {
    for (const violation of report.violations) {
        console.log(`\n    ${violation.from}:${violation.line} → ${violation.to}`);
        console.log(`      ${violation.reason}`);
    }
}

console.log('\n  Циклы между слоями:');
console.log(
    report.cycle
        ? `    ${report.cycle.files.join(' → ')} → ${report.cycle.files[0]}`
        : '    нет',
);

console.log('\n  Циклы внутри слоя:');
if (report.internalCycle) {
    for (const edge of report.internalCycle.edges) {
        console.log(`    ${edge.from}:${edge.line} → ${edge.to}`);
    }
    console.log(
        '    Цикл внутри слоя — это другой дефект, чем слой, дотянувшийся\n' +
            '    куда нельзя: здесь два модуля зависят друг от друга, и порядок\n' +
            '    их загрузки определяет, что у кого окажется.\n',
    );
} else {
    console.log('    нет');
}

console.log(
    '  ' + '='.repeat(88) +
        '\n  Особый случай, который роадмап называет первым: research → production.\n' +
        '  Измерять можно всё. Производственный код, тянущий research, — это как\n' +
        '  раз то, из-за чего модуль получает модель исполнения, которую не выбирал.\n' +
        '  Именно такой дефект обнулил все числа проекта раньше.\n',
);

const clean = report.violations.length === 0 && report.cycle === null && report.unplaced.length === 0;

console.log(
    clean
        ? '  Итог: объявленное соблюдается, между слоями циклов нет.\n'
        : '  Итог: перечисленное выше требует решения, а не молчания.\n',
);
process.exitCode = clean ? 0 : 1;
