/**
 * Writes the PHASE 45 documents that are generated rather than written.
 *
 * ```
 * node --env-file=.env --import=tsx src/backend/research/docs-generate.cli.ts
 * ```
 *
 * Run it after a deliberate change to the code or the schema, and commit the
 * documents it writes together with that change. `docs.test.ts` is what makes
 * the pair honest: it rebuilds these files and fails when they differ, so a
 * document cannot fall behind silently and a document cannot be edited by hand
 * to agree with a stale reading.
 *
 * **The generated set is deliberately short.** Only documents whose content is
 * a fact about the repository go through here. A document built from configured
 * values would change with `.env`, so it would describe one machine and fail the
 * check on another while both were correct — see the header of
 * `docs-generate.ts` for why `assets.md` and `market-data.md` are not here yet.
 *
 * **`database.md` is read out of a schema built here, on purpose.** The first
 * version of this command read `current_schema()` of whatever database the
 * environment pointed at, and produced fourteen tables — the live development
 * database is still on schema 13, three migrations behind. That is precisely the
 * defect §7 of the constitution carried for four rounds: a number quoted from a
 * database nobody re-ran. A scratch schema, migrated from scratch and dropped
 * after, is the only source that answers "what do the migrations build".
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, collectSchemaFacts, FILES } from './docs-generate.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const docsDir = join(repoRoot, 'docs');

const SCHEMA = `buynotbuy_docs_${randomUUID().replace(/-/g, '')}`;

/**
 * `search_path` in the connection string, not `SET`.
 *
 * The pool hands out connections from a queue, so a session-scoped `SET` applies
 * to whichever connection served that one statement and to none of the next. The
 * URL is the mechanism the test harness uses for the same reason, and it is the
 * one that travels with the connection.
 */
const url = new URL(process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/buynotbuy_test');
url.searchParams.set('options', `-c search_path=${SCHEMA}`);

process.env.DATABASE_URL = url.toString();

// Imported after the environment is set: `database.config.ts` parses the
// connection string once, at module scope, and a static import above would be
// evaluated first and capture the wrong one.
const { closePool, query } = await import('../db/pool.js');
const { applyMigrations } = await import('../db/migrations.js');

try {
    await query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await applyMigrations();

    const facts = { schema: await collectSchemaFacts(query) };

    for (const file of FILES) {
        const content = await build(file, facts);

        writeFileSync(join(docsDir, file), content, 'utf8');
        process.stdout.write(`${file}: ${content.split('\n').length} строк\n`);
    }

    // Printed once, because it is a property of the schema and not of any one
    // document: a first version appended the table count to every file's line,
    // which read as though four documents were about tables.
    process.stdout.write(
        `\nсхема ${SCHEMA}: ${facts.schema.tables.length} таблиц, ` +
            `${facts.schema.indexes.length} индексов\n`,
    );
} finally {
    // Dropped before the pool closes: the pool's connections are the cheapest
    // way back to the server, and a scratch schema left behind would be
    // indistinguishable from a real one on the next run.
    await query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await closePool();
}