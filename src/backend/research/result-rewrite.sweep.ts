/**
 * Sweep: writes that can change a value another row already holds.
 *
 * Rule 3 — old results are never rewritten — is easy to state and hard to check,
 * because the rewrite is usually an `ON CONFLICT` clause written to make a scan
 * idempotent. That is a good reason for it to exist and no reason at all for it
 * to be unconditional: the same clause that re-writes a row left pending by a
 * scan that ran too early also overwrites a row a scan finished last week, and
 * the second case leaves nothing behind.
 *
 * The mechanically detectable part is the guard. An `ON CONFLICT DO UPDATE`
 * that carries no `WHERE` accepts the incoming row regardless of what is
 * already stored; one that does carries the project's own statement about which
 * of the two is allowed to win. Both are legitimate — what this lists is which
 * ones have said it.
 *
 * This is a list of shapes, not of bugs. Reading it is the work: a bare clause
 * over a pending record is correct, and a bare clause over a settled one is the
 * thing rule 3 is about.
 */
import ts from 'typescript-5';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP = new Set(['node_modules', 'test-support', 'research', 'migrations']);

function sources(directory: string): string[] {
    const found: string[] = [];

    for (const entry of readdirSync(directory)) {
        if (SKIP.has(entry)) continue;

        const absolute = join(directory, entry);
        if (statSync(absolute).isDirectory()) {
            found.push(...sources(absolute));
        } else if (
            absolute.endsWith('.ts') &&
            !absolute.endsWith('.d.ts') &&
            !absolute.endsWith('.test.ts')
        ) {
            found.push(absolute);
        }
    }

    return found;
}

/**
 * The tables a measurement is written to.
 *
 * Named rather than inferred: the question is not "does this file write", it is
 * "does this file write somewhere a number was read back out of". A table of
 * names is a statement about which tables those are, and it can be argued with.
 */
const RESULT_TABLES = new Set([
    'signal_outcome',
    'signal_snapshot',
    'signal_history',
    'signal_strategy_version',
    'indicator_performance',
    'market_candles',
]);

interface Finding {
    file: string;
    line: number;
    table: string;
    kind: string;
    /**
     * The statement's own `WHERE`, verbatim, or null.
     *
     * **Reported rather than scored, because scoring it would be a lie.** The
     * first version counted any `WHERE` after the `SET` list as a guard, and
     * `WHERE id = $1 AND rule_id = $2` duly counted — while saying nothing
     * about whether the row it addressed may be rewritten. Addressing a row and
     * permitting an overwrite are different things, and only one of them is what
     * rule 3 is about.
     *
     * The condition that answers rule 3 names the *existing* value —
     * `WHERE verdict IN ('unknown', 'expired')` says a pending row may be
     * replaced and a settled one may not. That is a judgement to read, not a
     * property to infer, so the text is handed over intact.
     */
    where: string | null;
}

const findings: Finding[] = [];

/** The SQL text of a template literal or plain string literal. */
function sqlOf(node: ts.Node): { text: string; line: number } | undefined {
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return {
            text: node.getText(),
            line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
        };
    }

    if (ts.isStringLiteral(node)) {
        return {
            text: node.text,
            line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
        };
    }

    return undefined;
}

/**
 * SQL held in a module-level constant and passed by name.
 *
 * The first version of this sweep looked only at literals sitting in the
 * argument list, and so missed `candle.repository.ts:168` — the one statement in
 * the codebase that most obviously rewrites a result, `UPSERT_SQL`, written as
 * `const UPSERT_SQL = \`...\`` and then called as `query(UPSERT_SQL, params)`.
 * The sweep reported four writes and would have recorded "two of them
 * unguarded" as a result, while the loudest instance of the shape it exists to
 * find was not in the list at all.
 *
 * A tool that misses findings is worse than one that reports noise, because its
 * quiet gets written down as an answer. Constants are collected per file and
 * resolved by name.
 */
function constantsOf(source: ts.SourceFile): Map<string, string> {
    const found = new Map<string, string>();

    for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;

        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name)) continue;

            const initializer = declaration.initializer;
            if (initializer === undefined) continue;

            const sql = sqlOf(initializer);
            if (sql !== undefined) {
                found.set(declaration.name.text, sql.text);
            }
        }
    }

    return found;
}

for (const file of sources(root)) {
    const relativePath = relative(root, file).split(sep).join('/');
    const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );

    const constants = constantsOf(source);

    const visit = (node: ts.Node): void => {
        const parent = node.parent;
        const isArgument =
            parent !== undefined &&
            ts.isCallExpression(parent) &&
            parent.arguments.some((argument) => argument === node);

        // A statement reaches a query as a literal or as a name. Both.
        const sql = ts.isIdentifier(node)
            ? constants.has(node.text)
                ? {
                      text: constants.get(node.text) ?? '',
                      line:
                          node.getSourceFile().getLineAndCharacterOfPosition(node.getStart())
                              .line + 1,
                  }
                : undefined
            : sqlOf(node);

        if (isArgument && sql !== undefined) {
                const upper = sql.text.toUpperCase();
                const hasConflictUpdate = upper.includes('DO UPDATE');
                const hasPlainUpdate = /\bUPDATE\s+[A-Z_]+/.test(upper);
                const hasDelete = /\bDELETE\s+FROM\b/.test(upper);

                if (hasConflictUpdate || hasPlainUpdate || hasDelete) {
                    // The table is named in the statement; a statement naming
                    // several is counted once, on the first.
                    const match = upper.match(
                        /(?:INTO|UPDATE|FROM)\s+([A-Z_][A-Z0-9_]*)/,
                    );
                    const table = match?.[1]?.toLowerCase() ?? '?';

                    if (RESULT_TABLES.has(table)) {
                        const afterSet = upper.indexOf('SET');
                        const whereAt = upper.indexOf('WHERE', afterSet);

                        findings.push({
                            file: relativePath,
                            line: sql.line,
                            table,
                            kind: hasConflictUpdate
                                ? 'ON CONFLICT DO UPDATE'
                                : hasDelete
                                  ? 'DELETE'
                                  : 'UPDATE',
                            where:
                                whereAt === -1
                                    ? null
                                    : upper
                                          .slice(whereAt)
                                          .replace(/\s+/g, ' ')
                                          .trim()
                                          .slice(0, 90),
                        });
                    }
                }
            }

        ts.forEachChild(node, visit);
    };

    visit(source);
}

const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
};

const files = sources(root).length;

say(`Production files scanned: ${files}`);
say(`Result-table writes found: ${findings.length}`);
say('');

const order = (finding: Finding): string =>
    `${finding.file}:${finding.line} ${finding.kind} ${finding.table}`;

for (const finding of [...findings].sort((a, b) => order(a).localeCompare(order(b)))) {
    say(`  ${finding.file}:${finding.line}  ${finding.kind.padEnd(22)} ${finding.table}`);
    say(`      ${finding.where ?? 'БЕЗ WHERE — перезапись безусловна'}`);
}

say('');
say(`Unconditional: ${findings.filter((finding) => finding.where === null).length} of ${findings.length}.`);
say('A bare ON CONFLICT DO UPDATE is correct over a row a scan left pending.');
say('It is the thing rule 3 is about when the row it overwrites was finished.');
say('The question to ask of each WHERE below is whether it names the existing');
say('value — that is what says a settled row may not be replaced.');
