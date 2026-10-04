/**
 * M0's map of the backend, generated rather than written.
 *
 *   node --env-file=.env --import=tsx src/backend/research/architecture-map.cli.ts
 *
 * The roadmap asks PHASE 0 to document, for every layer, its responsibility,
 * inputs, outputs, tables, API and invariants. The tables and the API are read
 * off the code; the responsibilities are not, and the file says which is which
 * so nobody later mistakes a generated section for a decided one.
 */


import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from '../db/migrations.js';
import { audit } from './architecture-lint.js';
import { LAYERS, summarise, UNIVERSAL, UNPLACED } from './dependency-graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const graph = summarise(root);
const symbols = audit(root);

const pad = (value: string, width: number): string => value.padEnd(width);

const migrationsSource = readFileSync(join(root, 'db', 'migrations.ts'), 'utf8');

/** Table names, read out of the migration source rather than remembered. */
const tables = [...migrationsSource.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(
    (match) => match[1]!,
);

const routesDir = join(root, 'api', 'routes');
const routes = readdirSync(routesDir)
    // A test file in api/routes is a test of a route, not a route. Listing it
    // as one would make the section claim more than it measured, which is the
    // one thing a section labelled "прочитано из кода" must never do.
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => name.replace(/\.ts$/, ''));

console.log('='.repeat(94));
console.log('M0. КАРТА BACKEND. ЧАСТЬ СГЕНЕРИРОВАНА, ЧАСТЬ — РЕШЕНИЕ');
console.log('='.repeat(94));

console.log('\n  СЛОИ. «вход» — рёбра, входящие в слой, «выход» — исходящие.\n');
console.log('  Рёбра внутри слоя не считаются: слой, разговаривающий сам с собой,\n');
console.log('  не имеет более широкой границы, чем та, что у него реально есть.\n');
for (const layer of LAYERS) {
    const row = graph.byLayer.find((entry) => entry.layer === layer.name);

    if (!row) {
        continue;
    }

    const kind = layer.composition
        ? 'составляющий'
        : (UNIVERSAL.includes(layer.name) ? 'сквозной лист' : 'ядро');

    console.log(
        `  ${pad(layer.name, 15)} ${String(row.files).padStart(3)} файлов  ` +
            `вход ${String(row.in).padStart(3)}  выход ${String(row.out).padStart(3)}  ${pad(kind, 14)}`,
    );
    const where = Object.keys(row.outTo).filter((to) => to !== layer.name);

    if (where.length > 0) {
        console.log(
            `  ${' '.repeat(15)}   → ${where.map((to) => `${to}(${row.outTo[to]})`).join(' ')}`,
        );
    }
}
for (const [name] of Object.entries(UNPLACED)) {
    const row = graph.byLayer.find((entry) => entry.layer === name);

    if (row) {
        console.log(
            `  ${pad(name, 15)} ${String(row.files).padStart(3)} файлов  ` +
                `вход ${String(row.in).padStart(3)}  выход ${String(row.out).padStart(3)}  (вне таблицы)`,
        );
    }
}

console.log(`\n  ИТОГО: ${graph.files} файлов, ${graph.edges} рёбер, ${graph.internal} внутри слоя`);
console.log(`  Рёбер, не разрешённых объявлением: ${graph.violations.length}`);
console.log(`  Циклов между слоями: ${graph.cycle ? 1 : 0}. Внутри слоя: ${graph.internalCycle ? 1 : 0}.`);

console.log('\n  БАЗА ДАННЫХ (прочитано из миграций)\n');
console.log(`  Версий миграций: ${MIGRATIONS.length}, последняя — v${MIGRATIONS.at(-1)?.version}`);
console.log(`  Таблиц: ${tables.length}, ограничений CHECK: ${(migrationsSource.match(/CHECK\s*\(/g) ?? []).length}\n`);
for (const table of tables) {
    console.log(`    ${table}`);
}

console.log('\n  HTTP (прочитано из api/routes)\n');
for (const route of routes) {
    console.log(`    ${route}`);
}

console.log('\n  ЗАШИТЫЙ РЫНОК\n');
console.log(`  Упоминаний в комментариях (записи измерений): ${symbols.documented}`);
console.log(`  Строковых литералов в коде, разрешённый слой:  ${symbols.configured}`);
console.log(`  Строковых литералов в коде, домен:              ${symbols.violations.length}`);
for (const violation of symbols.violations) {
    console.log(`    ${violation.file}:${violation.line}  ${violation.value}`);
}

console.log(
    '\n  ' + '='.repeat(90) +
        '\n  ГРАНИЦА МЕЖДУ ИЗМЕРЕННЫМ И ЗАЯВЛЕННЫМ\n' +
        '  Всё выше прочитано из кода и разойтись с ним не может. Ответственности\n' +
        '  слоёв, входов и выходов здесь нет намеренно: они не измеряются, они\n' +
        '  объявляются, и объявлять их должен владелец. В docs/invariants.md\n' +
        '  каждое утверждение помечено тем, чем оно обеспечено, и это разделение\n' +
        '  стоит дороже, чем сама карта.\n',
);
