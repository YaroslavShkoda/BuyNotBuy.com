import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { query } from '../db/pool.js';

/**
 * `docs/invariants.md` is the constitution, and nothing was checking it.
 *
 * The document opens by claiming that each entry names the code that enforces
 * it, and closes by promising four commands that verify the table has not
 * drifted from the code. Those four commands check the code: the layer map,
 * the layering rule, the dependency graph and the test suite. **None of them
 * reads `invariants.md`.** So every claim in the constitution was true or false
 * according to what a reader remembered, and the file was 22 entries long
 * before anything asked.
 *
 * Three claims had already gone false, and the summary did not add up:
 *
 * - §7 is enforced by `CHECK (status IN ('draft', 'approved', 'retired'))` on
 *   `strategy_version.status`. Migration 16 dropped that column, and §8 says so
 *   in the next section. The constitution asserted a constraint on a column it
 *   had removed six sections earlier.
 * - §7 quotes "28 CHECK on 16 tables". A schema built from the current
 *   migrations has 37 and 17.
 * - The summary reports 15 enforced, 1 partial, 1 declared and 3 violated —
 *   twenty entries for twenty-two sections, and the one it calls merely
 *   declared (§8) reads "enforced on `strategy_rule`" in its own table.
 *
 * Fixing three numbers would have left the same drift to happen again, so the
 * entries are checked instead. A constitution that cannot fail is prose with
 * a table around it.
 */

/** Repository root: `src/backend/research` is two levels below it. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendRoot = join(repoRoot, 'src', 'backend');

const document = readFileSync(join(repoRoot, 'docs', 'invariants.md'), 'utf8');

interface Entry {
    number: number;
    title: string;
    status: string;
    body: string;
}

const entries: Entry[] = [];

for (const section of document.split(/\n(?=## )/)) {
    const heading = /^## (\d+)\. (.+)$/m.exec(section);

    if (heading === null) continue;

    entries.push({
        number: Number(heading[1]),
        title: heading[2]!.trim(),
        // The row is `| **Статус** | <text> |`. Trimmed, because two entries
        // carry a reason after the status and the reason is not the status.
        status: (/\|\s*\*\*Статус\*\*\s*\|\s*([^|]*)\|/.exec(section)?.[1] ?? '').trim(),
        body: section,
    });
}

/**
 * The closed set of statuses, longest match first.
 *
 * Order is the content, not a detail: "не обеспечен" contains "обеспечен", so
 * a classifier that tested for the short word first would report both violated
 * entries as enforced. A vocabulary with no closed set is how the document
 * ended up with four buckets and twenty-two entries that sorted into none of
 * them consistently.
 */
const VOCABULARY: ReadonlyArray<readonly [string, Bucket]> = [
    ['не обеспечен', 'violated'],
    ['только заявлен', 'declared'],
    ['обнаружено, не исправлено', 'found'],
    ['обеспечен частично', 'partial'],
    ['обеспечен', 'ensured'],
    ['нарушено', 'violated'],
];

type Bucket = 'ensured' | 'partial' | 'declared' | 'violated' | 'found';

function bucket(status: string): Bucket {
    for (const [prefix, name] of VOCABULARY) {
        if (status.toLowerCase().startsWith(prefix)) return name;
    }

    throw new Error(
        `Инвариант записан со статусом, которого нет в закрытом множестве: "${status}". ` +
            `Допустимы: ${VOCABULARY.map(([prefix]) => prefix).join(', ')}.`,
    );
}

describe('the constitution declares an enforceable status for every entry', () => {
    it('has a numbered entry for each rule, with no gaps and no repeats', () => {
        const numbers = entries.map((entry) => entry.number);

        expect(numbers).toHaveLength(new Set(numbers).size);
        expect([...numbers].sort((a, b) => a - b)).toEqual(
            Array.from({ length: numbers.length }, (_, index) => index + 1),
        );
    });

    it('records a status for every entry', () => {
        const missing = entries
            .filter((entry) => !entry.status)
            .map((entry) => `${entry.number}. ${entry.title}`);

        expect(missing).toEqual([]);
    });

    it('uses only statuses the classifier knows', () => {
        // `bucket` throws on an unknown status, so this asserts the vocabulary
        // rather than re-implementing the match.
        const unknown = entries.filter((entry) => {
            try {
                bucket(entry.status);
                return false;
            } catch {
                return true;
            }
        });

        expect(unknown.map((entry) => `${entry.number}: ${entry.status}`)).toEqual([]);
    });

    it('counts in the summary the statuses the entries actually carry', () => {
        const counted = new Map<Bucket, number>();

        for (const entry of entries) {
            const name = bucket(entry.status);
            counted.set(name, (counted.get(name) ?? 0) + 1);
        }

        // Read out of the summary table rather than the prose above it: the
        // table is the one a reader checks, and the prose is where the two
        // copies drifted apart in the first place.
        const summary = document.slice(document.indexOf('## Сводка'));
        const declared = /Обеспечены кодом или базой \| \*\*(\d+)\*\*/.exec(summary);
        const partial = /Обеспечены частично \| \*\*(\d+)\*\*/.exec(summary);
        const onlyDeclared = /Только заявлены \| \*\*(\d+)\*\*/.exec(summary);
        const violated = /Нарушены и зафиксированы \| \*\*(\d+)\*\*/.exec(summary);

        expect({
            ensured: Number(declared?.[1] ?? -1),
            partial: Number(partial?.[1] ?? -1),
            declared: Number(onlyDeclared?.[1] ?? -1),
            violated: Number(violated?.[1] ?? -1),
        }).toEqual({
            ensured: counted.get('ensured') ?? 0,
            partial: counted.get('partial') ?? 0,
            declared: counted.get('declared') ?? 0,
            violated: (counted.get('violated') ?? 0) + (counted.get('found') ?? 0),
        });
    });
});

describe('the constitution names files that exist', () => {
    it('resolves every path written in backticks', () => {
        const mentioned = [
            ...new Set(
                [...document.matchAll(/`([a-z0-9][a-z0-9._/-]*\.ts)`/g)].map(
                    (match) => match[1]!,
                ),
            ),
        ].sort();

        const unresolved = mentioned.filter((path) => {
            // A path may be written relative to the backend root or to the
            // repository root, and several entries name a bare file name and
            // rely on the reader knowing the folder. A name that exists
            // somewhere under the backend counts as resolved; one that exists
            // nowhere is a file that was renamed or deleted, and the entry now
            // points at nothing.
            const candidates = [
                join(repoRoot, path),
                join(backendRoot, path),
                ...listFiles(backendRoot)
                    .filter((file) => file.endsWith(`/${path}`) || file.endsWith(path))
                    .map((file) => join(backendRoot, file)),
            ];

            return !candidates.some((candidate) => existsSync(candidate));
        });

        expect(unresolved).toEqual([]);
    });
});

/** Every `.ts` under a directory, relative to it. */
function listFiles(directory: string, found: string[] = []): string[] {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;

        const absolute = join(directory, entry.name);

        if (entry.isDirectory()) {
            listFiles(absolute, found);
        } else if (entry.name.endsWith('.ts')) {
            found.push(slice(absolute));
        }
    }

    return found;
}

function slice(absolute: string): string {
    return absolute.slice(backendRoot.length + 1).split(/[\\/]/).join('/');
}

/**
 * Names the document mentions and states do not exist.
 *
 * Listed here, in the open, rather than filtered inside the check: a sweep
 * that drops the exceptions silently reports a clean result over a document
 * that names things nobody can look up. `strategy_rule` is the entry — six
 * rounds of this file cited it as the table where the promotion ladder is
 * enforced, and it was never created. §8 now says so, and the exception is
 * what makes that sentence checkable rather than another claim.
 */
const KNOWN_ABSENT = new Set(['strategy_rule']);

/**
 * The rows where the document names what enforces an invariant.
 *
 * Not the whole document: the prose above and below cites words like `fresh`,
 * `intrabar` and `rejected` in passing, and a check over all of it reports the
 * alphabet. What matters is narrower and is where this class of error lived —
 * a cell whose job is to point at the thing that makes the rule true.
 */
const ENFORCEMENT_ROW =
    /\|\s*\*\*(?:Обеспечен|Где обеспечено на деле|Чем|Проверяется|Где нарушено)\*\*/;

/**
 * A name that looks like a schema object rather than a code symbol.
 *
 * Lowercase with an underscore. `config_hash`, `schema_migrations` and
 * `signal_strategy_version_stage_check` qualify and must resolve against the
 * built schema. `CANDIDATE_STAGES`, `canTransition`, `splitTicker` and
 * `assertCandleSeries` do not — they are TypeScript, they are named as
 * TypeScript, and a check that demanded they be tables would push the document
 * towards saying less rather than towards saying the wrong thing.
 */
function looksLikeSchemaObject(name: string): boolean {
    return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name);
}

describe('the constitution names objects that exist', () => {
    it('finds every schema object it cites as the thing that enforces a rule', async () => {
        // The setup file has already applied every migration into this file's
        // own schema, so this reads the same tables, columns and constraints
        // the code runs against — no second migration pass, and nothing
        // borrowed from `public`.
        const built = await query<{ object_name: string }>(
            `SELECT table_name AS object_name FROM information_schema.tables
              WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
             UNION ALL
             SELECT column_name FROM information_schema.columns
              WHERE table_schema = current_schema()
             UNION ALL
             SELECT conname FROM pg_constraint
              WHERE connamespace = current_schema()::regnamespace`,
        );

        const known = new Set(built.rows.map((row) => row.object_name));

        const cited = new Set<string>();

        for (const line of document.split('\n')) {
            if (!ENFORCEMENT_ROW.test(line)) continue;

            for (const match of line.matchAll(/`([a-zA-Z_][a-zA-Z0-9_.]*)`/g)) {
                const name = match[1]!;

                // `signal_strategy_version.stage` is a column of a named table;
                // the base name is what has to exist first.
                const base = name.split('.')[0]!;

                if (looksLikeSchemaObject(name) || looksLikeSchemaObject(base)) {
                    cited.add(name);
                }
            }
        }

        const unaccounted = [...cited]
            .map((name) => name.split('.')[0]!)
            .filter((name) => !known.has(name) && !KNOWN_ABSENT.has(name))
            .sort();

        // The exempted names are asserted rather than trusted: an exemption that
        // outlives its reason is a hole with a comment on it.
        expect({ unaccounted, exempted: [...KNOWN_ABSENT].sort() }).toEqual({
            unaccounted: [],
            exempted: ['strategy_rule'],
        });
    });

    it('quotes the constraint counts the current migrations produce', async () => {
        // §7 tells the reader that a closed set of values is the most reliable
        // class of invariant in the project, and backs the claim with a count.
        // The count was 28 on 16 tables, quoted from a database nobody re-ran.
        //
        // Measured rather than matched: this compares the numbers written in the
        // document with the numbers the migrated schema has, so the failure says
        // what to write instead of only that something is wrong. Asserting the
        // literal sentence instead would have kept the same decay one level down
        // — a checked string is still a string.
        const counted = await query<{ checks: string; tables: string }>(
            `SELECT
                (SELECT count(*) FROM pg_constraint
                  WHERE contype = 'c' AND connamespace = current_schema()::regnamespace) AS checks,
                (SELECT count(*) FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = current_schema() AND c.relkind = 'r') AS tables`,
        );

        const checks = Number(counted.rows[0]?.checks ?? -1);
        const tables = Number(counted.rows[0]?.tables ?? -1);

        const stated = /(\d+) ограничений `CHECK` на (\d+) таблицах/.exec(document);

        expect({
            statedChecks: Number(stated?.[1] ?? -1),
            statedTables: Number(stated?.[2] ?? -1),
        }).toEqual({ statedChecks: checks, statedTables: tables });
    });
});