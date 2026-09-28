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

import { LAYERS, UNIVERSAL, UNPLACED, summarise } from './dependency-graph.js';
import { audit } from './architecture-lint.js';
import { MIGRATIONS } from '../db/migrations.js';

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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
    .filter((name) => name.endsWith('.ts'))
    .map((name) => name.replace(/\.ts$/, ''));

console.log('='.repeat(94));
console.log('M0. КАРТА BACKEND. ЧАСТЬ СГЕНЕРИРОВАНА, ЧАСТЬ — РЕШЕНИЕ');
console.log('='.repeat(94));

console.log('\n  СЛОИ\n');
for (const layer of LAYERS) {
    const row = graph.byLayer.find((entry) => entry.layer === layer.name);
    const kind = layer.composition
        ? 'составляющий'
        : (UNIVERSAL.includes(layer.name) ? 'сквозной лист' : 'ядро');

    console.log(
        `  ${pad(layer.name, 16)} ${String(row?.files ?? 0).padStart(4)} файлов  ` +
            `${String(row?.edges ?? 0).padStart(4)} рёбер  ${pad(kind, 16)} ` +
            (layer.composition ? '' : `→ ${layer.mayImport.join(', ') || 'ничего'}`),
    );
}
for (const [name, kind] of Object.entries(UNPLACED)) {
    const row = graph.byLayer.find((entry) => entry.layer === name);

    console.log(
        `  ${pad(name, 16)} ${String(row?.files ?? 0).padStart(4)} файлов  ` +
            `${String(row?.edges ?? 0).padStart(4)} рёбер  ${pad(kind, 16)} (вне таблицы)`,
    );
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
