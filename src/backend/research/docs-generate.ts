/**
 * The PHASE 45 documents, generated from the code rather than written about it.
 *
 * ```
 * npx vitest run src/backend/research/docs.test.ts          # does it still hold?
 * node --env-file=.env --import=tsx src/backend/research/docs-generate.cli.ts
 * ```
 *
 * `docs/invariants.md` was the last document nobody checked, and it had three
 * claims that were false and a summary that did not add up. The reason is now
 * written into that file; this module is the other half of the answer, because a
 * document that describes code is a copy, and a copy needs a diff.
 *
 * **Nothing here reads the environment.** That is the constraint that decides
 * the shape of every document below. A section built from a configured value —
 * a venue capability table, the asset registry — changes with `.env`, so the
 * file would describe one developer's machine and the check would fail on
 * another's while both were right. The documents that would need those facts
 * (`assets.md`, `market-data.md`) are therefore **not** generated yet, and the
 * reason is recorded in the status journal rather than left as a gap: a
 * generated document that varies with the environment is a document that
 * reports drift the moment the author's shell differs from CI.
 *
 * **Determinism is the other constraint, and it is what makes the check
 * possible.** No timestamps, every list sorted, every number printed from the
 * value that was measured. A generator that stamps the time makes its own check
 * fail on every run, and a check that always fails is a check nobody reads.
 */

import { LAYERS, UNIVERSAL, summarise } from './dependency-graph.js';
import { audit } from './architecture-lint.js';
import { METRIC_KIND, METRIC_NAMES } from '../observability/metrics.js';
import { MIGRATIONS } from '../db/migrations.js';

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/**
 * The statement runner the generator reads the schema through.
 *
 * Typed as the project's own `query` rather than a hand-written shape: a
 * narrower local signature is one more copy of the truth, and the first version
 * of this file cast `{ rows }` to an array and failed at the first `for..of`.
 */
export type Query = (
    text: string,
) => Promise<{ rows: Record<string, unknown>[] }>;

/* ------------------------------------------------------------------ schema */

interface ColumnRow {
    name: string;
    column: string;
    type: string;
    nullable: boolean;
}

interface CheckRow {
    name: string;
    constraint: string;
    definition: string;
}

interface IndexRow {
    table: string;
    name: string;
    definition: string;
}

export interface ColumnFact {
    readonly name: string;
    readonly type: string;
    readonly nullable: boolean;
}

export interface TableFact {
    readonly name: string;
    readonly columns: readonly ColumnFact[];
    readonly checks: readonly string[];
}

export interface SchemaFacts {
    readonly tables: readonly TableFact[];
    readonly indexes: readonly { name: string; table: string; definition: string }[];
}

/**
 * The schema as the migrations build it, read from the server.
 *
 * From the live catalogue rather than from the migration text on purpose. §7 of
 * the constitution was enforced by a `CHECK` that migration 16 had removed, and
 * it survived for four rounds precisely because the document quoted the SQL
 * nobody re-ran. A column list parsed out of a `CREATE TABLE` by regex is the
 * same quotation with more steps.
 *
 * `current_schema()`, never `public`: the schema under test is the one this
 * project's own setup file built and migrated, which is the only one the claims
 * are about.
 */
export async function collectSchemaFacts(run: Query): Promise<SchemaFacts> {
    const tables = (
        await run(
            `SELECT c.relname AS name, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
                    NOT a.attnotnull AS nullable
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_attribute a ON a.attrelid = c.oid
              WHERE n.nspname = current_schema() AND c.relkind = 'r'
                AND a.attnum > 0 AND NOT a.attisdropped
              ORDER BY c.relname, a.attnum`,
        )
    ).rows as ColumnRow[];

    const checks = (
        await run(
            `SELECT c.relname AS name, con.conname AS constraint,
                    pg_get_constraintdef(con.oid) AS definition
               FROM pg_constraint con
               JOIN pg_class c ON c.oid = con.conrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE con.contype = 'c' AND n.nspname = current_schema()
              ORDER BY c.relname, con.conname`,
        )
    ).rows as CheckRow[];

    const indexes = (
        await run(
            `SELECT tablename AS table, indexname AS name, indexdef AS definition
               FROM pg_indexes WHERE schemaname = current_schema()
              ORDER BY tablename, indexname`,
        )
    ).rows as IndexRow[];

    const byTable = new Map<string, TableFact>();

    for (const row of tables) {
        const existing = byTable.get(row.name) ?? {
            name: row.name,
            columns: [],
            checks: [],
        };

        existing.columns.push({
            name: row.column,
            type: row.type,
            nullable: row.nullable,
        });
        byTable.set(row.name, existing);
    }

    for (const row of checks) {
        const table = byTable.get(row.name);

        if (table !== undefined) {
            table.checks.push(`${row.constraint}: ${row.definition}`);
        }
    }

    return {
        tables: [...byTable.values()].sort((a, b) => a.name.localeCompare(b.name)),
        indexes: indexes.map((row) => ({
            name: row.name,
            table: row.table,
            definition: row.definition,
        })),
    };
}

/* ------------------------------------------------------------------ routes */

interface RouteFact {
    readonly method: string;
    readonly path: string;
    readonly file: string;
}

/**
 * Routes, read out of the registration calls.
 *
 * A route table written by hand is a list of intentions; this is a list of what
 * the process registers. The difference shows up the moment someone adds an
 * endpoint and forgets the document — which is the only moment the document
 * matters.
 */
function collectRoutes(): RouteFact[] {
    const routesDir = join(root, 'api', 'routes');
    const found: RouteFact[] = [];

    for (const name of readdirSync(routesDir).sort()) {
        // A test file in api/routes is a test of a route, not a route.
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;

        const file = join(routesDir, name);
        const source = readFileSync(file, 'utf8');

        for (const match of source.matchAll(
            /\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g,
        )) {
            found.push({
                method: match[1]!.toUpperCase(),
                path: match[2]!,
                file: relative(root, file).split(sep).join('/'),
            });
        }
    }

    return found.sort((a, b) =>
        `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
    );
}

/* -------------------------------------------------------------- documents */

const BANNER = (command: string): string =>
    `<!-- Сгенерировано. Правьте генератор: src/backend/research/docs-generate.ts\n` +
    `     и перегенерируйте: ${command} -->\n`;

/**
 * The banner a document carries, so a reader who wants to change one knows it
 * is a copy. Half of these files existed as hand-written descriptions of code,
 * and the ones that survived were the ones nobody opened again.
 */
export const GENERATOR_COMMAND =
    'node --env-file=.env --import=tsx src/backend/research/docs-generate.cli.ts';

/**
 * The graph and the lint, once.
 *
 * Both walk two hundred files and both are pure functions of the repository, so
 * recomputing them per document bought nothing and cost the test suite enough to
 * exceed the five-second limit under load — which is how a check that passes
 * alone fails in the full run, and a check like that is not a check.
 *
 * The document builders stay un-memoised on purpose: the determinism test
 * compares two independent builds, and sharing a cache between them would make
 * it compare a value with itself.
 */
let measured: { graph: ReturnType<typeof summarise>; symbols: ReturnType<typeof audit> } | null =
    null;

function measurement(): {
    graph: ReturnType<typeof summarise>;
    symbols: ReturnType<typeof audit>;
} {
    measured ??= { graph: summarise(root), symbols: audit(root) };

    return measured;
}

function architecture(): string {
    const { graph, symbols } = measurement();

    const lines: string[] = [];

    lines.push(BANNER(GENERATOR_COMMAND));
    lines.push('# Архитектура бэкенда');
    lines.push('');
    lines.push(
        'Часть сгенерирована, часть — решение. Ответственности слоёв здесь нет',
        'намеренно: они не измеряются, они объявляются, и объявлять их должен',
        'владелец. Всё, что ниже прочитано из кода, разойтись с ним не может.',
        '',
    );

    lines.push('## Слои');
    lines.push('');
    lines.push(
        '`вход` — рёбра, входящие в слой, `выход` — исходящие. Рёбра внутри слоя',
        'не считаются: слой, разговаривающий сам с собой, не имеет более широкой',
        'границы, чем та, что у него реально есть.',
        '',
    );
    lines.push(`| слой | файлов | вход | выход | род |`);
    lines.push(`|---|---|---|---|---|`);

    for (const layer of LAYERS) {
        const row = graph.byLayer.find((entry) => entry.layer === layer.name);

        if (row === undefined) continue;

        const kind = layer.composition
            ? 'составляющий'
            : UNIVERSAL.includes(layer.name)
              ? 'сквозной лист'
              : 'ядро';

        lines.push(
            `| \`${layer.name}\` | ${row.files} | ${row.in} | ${row.out} | ${kind} |`,
        );
    }

    lines.push('');
    lines.push('### Куда каждый слой импортирует');
    lines.push('');

    for (const layer of LAYERS) {
        const row = graph.byLayer.find((entry) => entry.layer === layer.name);
        const where = Object.keys(row?.outTo ?? {}).filter((to) => to !== layer.name);

        if (where.length === 0) continue;

        lines.push(
            `- \`${layer.name}\` → ${where
                .map((to) => `\`${to}\`${row?.outTo[to] === undefined ? '' : ` (${row.outTo[to]})`}`)
                .join(', ')}`,
        );
    }

    lines.push('');
    lines.push('## Циклы');
    lines.push('');
    lines.push(
        `Между слоями: ${graph.cycle === null ? 'нет' : 'есть'}.`,
        '',
        `Внутри слоя: ${graph.internalCycle === null ? 'нет' : 'есть'}.`,
        '',
    );

    for (const [title, cycle] of [
        ['Между слоями', graph.cycle],
        ['Внутри слоя', graph.internalCycle],
    ] as const) {
        if (cycle === null) continue;

        lines.push(`### ${title}: ${cycle.files.join(' → ')}`);
        lines.push('');
    }

    if (graph.internalCycle !== null) {
        lines.push(
            'Цикл внутри слоя — другой дефект, чем слой, дотянувшийся куда нельзя:',
            'здесь два модуля зависят друг от друга, и порядок их загрузки определяет,',
            'что у кого окажется. Слой при этом остаётся достижимым, поэтому ни граф',
            'слоёв, ни проверка достижимости его не показывают.',
            '',
        );
    }

    lines.push('## Объявленные рёбра, которых нет в коде');
    lines.push('');
    lines.push(
        `Найдено: **${graph.violations.length}**. Ни одно не разрешено объявлением:`,
        'список ниже выведен из данных, а не восстановлен из текста отчёта.',
        '',
    );

    for (const violation of graph.violations) {
        lines.push(`- \`${violation.from}\` → \`${violation.to}\` — ${violation.reason}`);
    }

    lines.push('');
    lines.push('## Зашитый рынок');
    lines.push('');
    lines.push(
        `Упоминаний в комментариях (записи измерений): ${symbols.documented}.`,
        '',
        `Строковых литералов в коде, разрешённый слой: ${symbols.configured}.`,
        '',
        `Строковых литералов в коде, домен: **${symbols.violations.length}**.`,
        '',
    );

    for (const violation of symbols.violations) {
        lines.push(`- \`${violation.file}:${violation.line}\` — \`${violation.value}\``);
    }

    lines.push('');
    lines.push(
        'Ноль в домене — это не «мы не нашли», а «проверка не может не найти»:',
        'архитектурный lint объявляет, где символ читать можно, и любое другое',
        'чтение попадает в список выше.',
        '',
    );

    return lines.join('\n');
}

function api(): string {
    const routes = collectRoutes();

    const lines: string[] = [];

    lines.push(BANNER(GENERATOR_COMMAND));
    lines.push('# HTTP-поверхность');
    lines.push('');
    lines.push(
        'Прочитано из вызовов регистрации в `api/routes`. Таблица, написанная руками,',
        'перечисляет намерения; эта перечисляет то, что процесс регистрирует.',
        '',
    );
    lines.push('| метод | путь | модуль |');
    lines.push('|---|---|---|');

    for (const route of routes) {
        lines.push(`| \`${route.method}\` | \`${route.path}\` | \`${route.file}\` |`);
    }

    lines.push('');
    lines.push('## Что здесь заморожено, а что добавлено');
    lines.push('');
    lines.push(
        'Четыре маршрута заморожены контрактом фронтенда в `src/app/**`:',
        '`/api/analysis`, `/api/market`, `/api/price`, `/api/signal-history`.',
        'Маршруты про инструменты добавлены рядом с ними и не меняли ни одного из',
        'них — пара «старый + новый» это слой совместимости по замыслу, а не долг.',
        '',
        '`/api/market` читает настроенный рынок, потому что для этого он и построен,',
        'и параметра у него нет. `/api/instruments/:ticker` называет один инструмент',
        'явно — и это единственный способ спросить про второй рынок.',
        '',
    );

    return lines.join('\n');
}

function observability(): string {
    const lines: string[] = [];

    lines.push(BANNER(GENERATOR_COMMAND));
    lines.push('# Наблюдаемость');
    lines.push('');
    lines.push(
        'Список метрик закрыт: новая метрика обязана быть объявлена в',
        '`observability/metrics.ts`, а тест сверяет экспозицию с этим обещанием.',
        'Три рода, потому что они означают разное, и схлопывание их теряет:',
        'счётчик отвечает «сколько раз», датчик — «сколько сейчас», распределение —',
        '«насколько плохо и как часто».',
        '',
    );

    for (const kind of ['counter', 'gauge', 'distribution'] as const) {
        const names = METRIC_NAMES.filter((name) => METRIC_KIND[name] === kind).sort();

        lines.push(`## ${kind} (${names.length})`);
        lines.push('');
        lines.push(names.map((name) => `\`${name}\``).join(', '));
        lines.push('');
    }

    lines.push('## Пробы');
    lines.push('');
    lines.push(
        '`/healthz` — жив ли процесс, `/readyz` — готов ли он принимать работу,',
        'включая сверку версии схемы базы, `/metrics` — экспозиция Prometheus.',
        '',
        'Реестр здоровья опрашивает **конфигурированный** рынок и фильтрует',
        'пробу свежести по нему же: иначе протухший BTCUSDT выдавался бы за свежий',
        'из-за движения другого рынка. Это тот класс дефекта, где отчёт говорил бы',
        'правду о рынке, которого не спрашивали.',
        '',
    );

    return lines.join('\n');
}

function database(schema: SchemaFacts): string {
    const lines: string[] = [];

    lines.push(BANNER(GENERATOR_COMMAND));
    lines.push('# База данных');
    lines.push('');
    lines.push(
        `Версий миграций: **${MIGRATIONS.length}**, последняя — ` +
            `v${MIGRATIONS.at(-1)?.version} «${MIGRATIONS.at(-1)?.name}».`,
        '',
        'Ниже — схема в том виде, в каком её строят текущие миграции, прочитанная',
        'из каталога сервера, а не из текста SQL. Таблица ограничений `CHECK` в',
        '`docs/invariants.md` когда-то цитировала SQL, который никто не',
        'перезапускал, и поэтому четыре раунда требовала несуществующего',
        'ограничения.',
        '',
    );

    lines.push(`## Таблицы (${schema.tables.length})`);
    lines.push('');

    for (const table of schema.tables) {
        lines.push(`### \`${table.name}\``);
        lines.push('');
        lines.push('| столбец | тип | null |');
        lines.push('|---|---|---|');

        for (const column of table.columns) {
            lines.push(`| \`${column.name}\` | \`${column.type}\` | ${column.nullable ? 'да' : 'нет'} |`);
        }

        lines.push('');

        if (table.checks.length > 0) {
            lines.push('Ограничения:');
            lines.push('');
            for (const check of table.checks) lines.push(`- \`${check}\``);
            lines.push('');
        }
    }

    lines.push(`## Индексы (${schema.indexes.length})`);
    lines.push('');
    lines.push('| индекс | таблица |');
    lines.push('|---|---|');

    for (const index of schema.indexes) {
        lines.push(`| \`${index.name}\` | \`${index.table}\` |`);
    }

    lines.push('');
    lines.push('## Политика хранения');
    lines.push('');
    lines.push(
        'Политика живёт в таблице `retention_policy`, а не в конфиге: её читает',
        'задание, и её должно быть видно в базе, а не только в исходниках. Границы',
        'по каждой таблице проверяются `db/retention.store.ts`.',
        '',
    );

    return lines.join('\n');
}

/**
 * Build one document by name. `database.md` needs the server, so it is built
 * from facts the caller collected rather than collected here — which keeps this
 * module free of a pool and readable without one.
 */
export async function build(
    file: string,
    facts: { schema: SchemaFacts },
): Promise<string> {
    switch (file) {
        case 'architecture.md':
            return architecture();
        case 'api.md':
            return api();
        case 'observability.md':
            return observability();
        case 'database.md':
            return database(facts.schema);
        default:
            throw new Error(`Документ не описан генератором: ${file}`);
    }
}

/** The files this generator owns, in the order they are written. */
export const FILES: readonly string[] = [
    'architecture.md',
    'database.md',
    'api.md',
    'observability.md',
];