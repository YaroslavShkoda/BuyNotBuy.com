import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { FILES, build, collectSchemaFacts } from './docs-generate.js';

import type { SchemaFacts } from './docs-generate.js';
import { query } from '../db/pool.js';

/**
 * The generated documents, checked against a rebuild.
 *
 * `docs/invariants.md` held three false claims and a summary that did not add up
 * for four rounds, because the four commands it offered for checking itself read
 * code and none of them opened the file. That is what this is for the rest of
 * `docs/`: a document that describes code is a copy, and a copy without a diff is
 * a claim.
 *
 * **Line endings are normalised before comparing.** Git rewrites LF to CRLF in
 * the working tree on this machine, so a byte comparison would fail on a document
 * nobody edited and pass on one somebody edited by hand — the opposite of what
 * this check is for.
 *
 * **A missing document fails rather than being created.** If the generator wrote
 * one on the fly, the first run of this test would produce the files and the
 * failure would surface on the next change instead, which is one commit too late.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const docsDir = join(repoRoot, 'docs');

const normalise = (text: string): string => text.replace(/\r\n/g, '\n').trimEnd();

/**
 * Collected in `beforeAll`, not at module scope.
 *
 * The schema this test reads is created and migrated by the setup file, and that
 * happens in a `beforeAll` — which runs after every module in the file has been
 * evaluated. Collecting at import time therefore reads a schema that does not
 * exist yet and finds zero tables, and the first version of this file did
 * exactly that: the rebuild produced `## Таблицы (0)` against a committed
 * document saying seventeen. The guard caught its own author.
 */
let facts: { schema: SchemaFacts };

beforeAll(async () => {
    facts = { schema: await collectSchemaFacts(query) };
});

describe('generated documents match a rebuild', () => {
    for (const file of FILES) {
        it(`${file} is what the generator produces`, async () => {
            const rebuilt = normalise(await build(file, facts));
            const committed = normalise(readFileSync(join(docsDir, file), 'utf8'));

            if (committed !== rebuilt) {
                // The first line that differs, so the message names a place
                // rather than asking the reader to diff two documents by eye.
                const committedLines = committed.split('\n');
                const rebuiltLines = rebuilt.split('\n');
                const at = committedLines.findIndex(
                    (line, index) => line !== rebuiltLines[index],
                );

                throw new Error(
                    `docs/${file} разошёлся с генератором.\n` +
                        `  строка ${at + 1}:\n` +
                        `    в файле:     ${committedLines[at] ?? '<конец файла>'}\n` +
                        `    в генераторе: ${rebuiltLines[at] ?? '<конец файла>'}\n` +
                        '  Перегенерируйте: node --env-file=.env --import=tsx ' +
                        'src/backend/research/docs-generate.cli.ts',
                );
            }

            expect(committed).toBe(rebuilt);
        });
    }
});

/**
 * One test rather than four, and with the limit stated.
 *
 * The per-file version built every document twice — eight builds of
 * `architecture.md` across the file — and under the full suite's load it
 * exceeded the five-second default and failed, while passing when run alone. The
 * project's own rule applies: a test that passes on an idle machine and fails on
 * a busy one is not a test. The limit is written down instead of inherited, and
 * the assertions are not weakened to fit it.
 */
describe('the generator is deterministic', () => {
    it(
        'builds every document twice to the same bytes, and stamps no time',
        async () => {
            const first: Record<string, string> = {};
            const second: Record<string, string> = {};

            for (const file of FILES) {
                first[file] = await build(file, facts);
                second[file] = await build(file, facts);
            }

            expect(second).toEqual(first);

            for (const file of FILES) {
                // A timestamp makes this check fail on every run, and a check
                // that always fails is a check nobody reads.
                expect(first[file]).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
            }
        },
        60_000,
    );
});

describe('the generator cannot quietly emit less', () => {
    /**
     * The comparison test above cannot see this class, and the round that added
     * the generator fell into it.
     *
     * `collectSchemaFacts` was refactored to accumulate columns and constraints
     * in two maps, and the constraints loop kept a guard that skipped a table it
     * had never seen — against a map nothing wrote to yet. Every constraint
     * disappeared from `database.md`, and regenerating would have committed the
     * loss with a green test, because the file and the generator would have
     * agreed on being wrong.
     *
     * So this asks the question a comparison cannot: is every constraint that
     * exists in the schema named in the document? It fails when the generator
     * drops one, whether or not the file was regenerated to match.
     */
    it('names every CHECK constraint the schema has', async () => {
        const constraints = await query<{ constraint: string }>(
            `SELECT conname AS constraint FROM pg_constraint
              WHERE contype = 'c' AND connamespace = current_schema()::regnamespace
              ORDER BY conname`,
        );

        const document = await build('database.md', facts);

        const missing = constraints.rows
            .map((row) => row.constraint)
            .filter((name) => !document.includes(name));

        expect(missing).toEqual([]);
    });

    it('names every table the schema has', async () => {
        const document = await build('database.md', facts);

        const missing = facts.schema.tables
            .map((table) => table.name)
            .filter((name) => !document.includes(name));

        expect(missing).toEqual([]);
    });
});
