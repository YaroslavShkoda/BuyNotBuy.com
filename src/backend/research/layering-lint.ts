/**
 * PHASE 46, second half. The rule that says what belongs in the data layer, as
 * a program rather than a sentence in a document.
 *
 * **The first version of the plan was wrong, and measuring is how that came
 * out.** The idea was to move ten repositories out of domain folders, and the
 * idea is worthless: a domain service that calls a repository imports the
 * implementation, so the layer edge it is forbidden to have does not change
 * when the file moves. Ten files and forty-four import sites later, the
 * architecture would look tidier and the rule would still be off.
 *
 * **What actually matters is not the folder, it is the SQL.** A domain that
 * writes `SELECT` is a domain whose tests need a database, and the moment one
 * of its rules changes, its tests only prove that the database works. That is
 * the defect, and it is not about where the file lives.
 *
 * So the rule is: *a file that touches the database lives in the data layer.*
 * Measured by what a file imports, not by what its strings look like — a regex
 * over SQL text cannot tell a query from a sentence in a comment, and a comment
 * is exactly what a measurement like this should be full of. A file is touching
 * the database when it imports `query`, `withTransaction` or `getPool` from a
 * `db/` module, and that is a fact about the module graph which the TypeScript
 * parser answers exactly.
 *
 * **One exemption, and it is not a general one.** `observability/health.registry.ts`
 * asks the database whether the database is up, and a health check that cannot
 * do that reports only on the code. It is listed by name with the reason
 * attached, which is the difference between an exception and a hole.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { dirname as posixDirname, join as posixJoin, normalize as posixNormalize } from 'node:path/posix';

import ts from 'typescript-5';

/** Folders that may touch the database. */
export const DATA_LAYER = 'db';

export const SKIPPED: readonly string[] = [
    'test-support',
    'node_modules',
    '.next',
    'fixtures',
    'research',
];

/** What counts as touching the database. Read from `db/`, nothing else. */
export const DATABASE_ACCESSORS: readonly string[] = [
    'query',
    'withTransaction',
    'getPool',
    'getDatabasePool',
];

/**
 * The one file kind outside the data layer that may talk to it.
 *
 * **A repository is the declared seam.** It exists to speak a domain's language
 * to the database, so importing the pool is its job rather than a breach of it,
 * and a repository that did not import it would not be a repository. Every
 * other file in a domain folder — a service, a rule, an indicator — reaching
 * into the database is the defect, because that is the code whose tests would
 * otherwise need a live database and prove only that the database works.
 *
 * This is what M2 was supposed to buy by moving ten repositories into `db/`,
 * and measurement says it is already bought: all eleven files that touch the
 * database outside `db/` are ten repositories and one health check, and every
 * one of the ten has tests. Moving them would have been forty-four import sites
 * and no change to what the rule protects.
 */
export const DATABASE_BEARING_FILES: readonly string[] = ['*.repository.ts'];

/** Whether this file is allowed to touch the database where it stands. */
export function isSeam(file: string): boolean {
    return DATABASE_BEARING_FILES.some((pattern) => {
        const suffix = pattern.replace('*', '');

        return file.endsWith(suffix);
    });
}

export interface Exemption {
    readonly file: string;
    readonly reason: string;
}

export const EXEMPT: readonly Exemption[] = [
    {
        file: 'observability/health.registry.ts',
        reason:
            'A health check has to be able to ask the database whether it is up. ' +
            'A probe that cannot does not report on the dependency, only on itself.',
    },
];

export interface Offence {
    /** Path relative to `src/backend`, with forward slashes. */
    readonly file: string;
    readonly line: number;
    /** The imported symbol that reached into the data layer. */
    readonly symbol: string;
    readonly reason: string;
}

const toPosix = (path: string): string => path.split(sep).join('/');

/** Files under `root`, in a stable order, as paths relative to `root`. */
export function listSources(root: string): string[] {
    const found: string[] = [];

    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir).sort()) {
            if (SKIPPED.includes(entry) || entry.startsWith('.')) {
                continue;
            }

            const full = join(dir, entry);

            if (statSync(full).isDirectory()) {
                walk(full);
            } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
                found.push(toPosix(relative(root, full)));
            }
        }
    };

    walk(root);

    return found;
}

/** The data layer a file belongs to, or null when it is in the data layer. */
export function dataLayerOf(file: string): string | null {
    return file.startsWith(`${DATA_LAYER}/`) ? DATA_LAYER : null;
}

/**
 * Database symbols a file imports from the data layer.
 *
 * Parsed, not scanned. The first scanner this project wrote walked into a
 * multi-line template literal, never came out, and reported no hardcode in a
 * file that had one on line 63 — silently, and in a way that looked like a
 * passing result. The import graph is a fact about modules, and the parser is
 * the only thing that answers it exactly.
 */
export function databaseImports(file: string, source: string): { symbol: string; line: number }[] {
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found: { symbol: string; line: number }[] = [];

    const lineOf = (node: ts.Node): number =>
        parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;

    const isDataLayer = (specifier: string): boolean => {
        if (!specifier.startsWith('.')) {
            // A bare specifier is a package, and this project's data layer is
            // not one of them.
            return false;
        }

        // Resolved against the importing file rather than pattern-matched. The
        // first version stripped a leading `./` and not `../`, so every real
        // import — which is `../db/pool.js` from anywhere but the root — was
        // invisible, and the guard reported a clean codebase that had ten
        // repositories in it. A rule that cannot see the thing it forbids is
        // worse than no rule, because it is believed.
        //
        // Resolved against a synthetic `/` rather than the process working
        // directory: the result has to be the same whether this runs from the
        // repository root or from anywhere else.
        const from = posixDirname(file);
        const resolved = posixNormalize(posixJoin('/', from, specifier.replace(/\.js$/, '')));

        if (!resolved.startsWith('/')) {
            return false;
        }

        const relativeToRoot = resolved.slice(1);

        return (
            relativeToRoot === DATA_LAYER || relativeToRoot.startsWith(`${DATA_LAYER}/`)
        );
    };

    for (const statement of parsed.statements) {
        if (!ts.isImportDeclaration(statement)) {
            continue;
        }

        const clause = statement.importClause;

        if (!clause || !ts.isStringLiteral(statement.moduleSpecifier)) {
            continue;
        }

        if (!isDataLayer(statement.moduleSpecifier.text)) {
            continue;
        }

        const bindings = clause.namedBindings;

        if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                const imported = (element.propertyName ?? element.name).text;

                if (DATABASE_ACCESSORS.includes(imported)) {
                    found.push({ symbol: imported, line: lineOf(element) });
                }
            }
        } else if (clause.name && DATABASE_ACCESSORS.includes(clause.name.text)) {
            found.push({ symbol: clause.name.text, line: lineOf(clause.name) });
        }
    }

    return found;
}

export interface Report {
    readonly files: number;
    /** Files outside the data layer that reach into it. */
    readonly offences: readonly Offence[];
    readonly exempt: readonly Exemption[];
    /**
     * Files that reach into the database and are allowed to: the declared
     * seams, and the one named exemption.
     *
     * Reported rather than hidden. A guard that counts only failures and says
     * nothing about what it accepted cannot be checked, and "there is no SQL in
     * the domain" and "the only SQL in the domain is in the ten files named
     * here" are different claims.
     */
    readonly seams: readonly string[];
}

export function audit(root: string): Report {
    const files = listSources(root);
    const offences: Offence[] = [];
    const exempt: Exemption[] = [];
    const seams: string[] = [];

    for (const file of files) {
        if (dataLayerOf(file) !== null) {
            continue;
        }

        const source = readFileSync(join(root, file), 'utf8');
        const imports = databaseImports(file, source);

        if (imports.length === 0) {
            continue;
        }

        const allowed = EXEMPT.find((entry) => entry.file === file);

        if (allowed) {
            exempt.push(allowed);
            continue;
        }

        if (isSeam(file)) {
            seams.push(file);
            continue;
        }

        for (const entry of imports) {
            offences.push({
                file,
                line: entry.line,
                symbol: entry.symbol,
                reason:
                    `«${file}» вне слоя данных импортирует ${entry.symbol} из ` +
                    `${DATA_LAYER}/ — доменный код, который пишет SQL, тестируется только ` +
                    'с живой базой',
            });
        }
    }

    return { files: files.length, offences, exempt, seams };
}
