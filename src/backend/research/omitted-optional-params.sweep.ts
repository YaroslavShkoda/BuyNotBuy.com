/**
 * Sweep: production call sites that omit a trailing optional parameter.
 *
 * The round-52 defect was this shape. `assertCandleSeries` took the interval as
 * an optional argument and used it to enable two safety checks; the backtest
 * omitted it and so measured across holes in the candle series, under a comment
 * claiming it did the same checks as the live path. Nothing failed, because the
 * parameter was genuinely optional and TypeScript had no reason to object.
 *
 * That is not a bug about candle data. It is a general one: an optional argument
 * that silently turns a check off is a check nobody can rely on. This lists
 * every place it could happen, so the list can be judged rather than guessed at.
 *
 * It is a list of candidates, not findings. Most optional parameters are
 * convenience and omitting them is correct. The ones worth reading are those
 * where the parameter's name or the function's own documentation says the
 * parameter is what makes the check possible.
 */


import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-5';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP = new Set(['node_modules', 'test-support', 'research', 'migrations']);
const isTest = (path: string): boolean => path.endsWith('.test.ts');

function sources(directory: string): string[] {
    const found: string[] = [];

    for (const entry of readdirSync(directory)) {
        if (SKIP.has(entry)) continue;

        const absolute = join(directory, entry);
        if (statSync(absolute).isDirectory()) {
            found.push(...sources(absolute));
        } else if (absolute.endsWith('.ts') && !absolute.endsWith('.d.ts') && !isTest(absolute)) {
            found.push(absolute);
        }
    }

    return found;
}

interface Optional {
    file: string;
    name: string;
    /** 1-based index of the parameter. */
    index: number;
    /** What the function's own leading comment says, first lines. */
    doc: string;
}

const isOptionalParameter = (parameter: ts.ParameterDeclaration): boolean =>
    parameter.questionToken !== undefined || parameter.initializer !== undefined;

function parametersOf(node: ts.SignatureDeclaration): ts.ParameterDeclaration[] {
    return [...(node.parameters ?? [])];
}

function leadingDoc(node: ts.Node): string {
    const ranges = ts.getLeadingCommentRanges(node.getFullText(), 0) ?? [];
    const text = ranges.map((range) => node.getFullText().slice(range.pos, range.end));

    return text
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
}

/** Collected from declarations, then matched against calls by origin. */
const declarations = new Map<string, Optional[]>();
const calls: Array<{
    file: string;
    origin: string;
    name: string;
    count: number;
    text: string;
}> = [];

/**
 * Which file each local name actually came from.
 *
 * **Without this the sweep is noise, and it demonstrated that immediately.** The
 * first run matched calls by bare identifier and reported 127 sites, of which the
 * largest group was a `number()` helper in `backtest.cli.ts` matching every
 * `Number(...)` call in the codebase — twenty-seven of them, in files that have
 * never imported it. A tool whose output is dominated by a category that cannot
 * exist is worse than no tool, because the real entries sit inside it.
 *
 * Names are bound to their origin file, and a call matches a declaration only
 * when the caller imported that name from that file or declares it locally.
 */
function importsOf(
    source: ts.SourceFile,
    file: string,
    relativeTo: (path: string) => string,
): Map<string, string> {
    const bound = new Map<string, string>();

    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        if (statement.importClause === undefined) continue;

        const specifier = statement.moduleSpecifier;
        if (!ts.isStringLiteral(specifier)) continue;

        const clause = statement.importClause;
        // Resolved and normalised to the same shape the declarations use:
        // repo-relative, `.ts`. Storing the raw specifier here — an absolute
        // path ending in `.js` — silently matched nothing across files, and the
        // sweep under-reported 21 sites as if it had found no others. A tool
        // that misses findings is worse than a noisy one, because its silence
        // gets recorded as a result.
        const from = relativeTo(join(dirname(file), specifier.text));

        if (clause.name !== undefined) {
            bound.set(clause.name.text, from);
        }

        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                bound.set(element.name.text, from);
            }
        }
    }

    return bound;
}

for (const file of sources(root)) {
    const relativePath = relative(root, file).split(sep).join('/');
    const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );

    const bound = importsOf(source, file, (path) =>
        relative(root, path.replace(/\.js$/, '.ts')).split(sep).join('/'),
    );

    const visit = (node: ts.Node): void => {
        if (
            (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
            node.name !== undefined
        ) {
            const optional = parametersOf(node).reduce<Optional[]>((found, parameter, offset) => {
                if (isOptionalParameter(parameter)) {
                    found.push({
                        file: relativePath,
                        name: node.name?.getText() ?? '<anonymous>',
                        index: offset + 1,
                        doc: leadingDoc(node),
                    });
                }
                return found;
            }, []);

            if (optional.length > 0) {
                const first = optional[0];

                if (first !== undefined) {
                    const existing = declarations.get(first.name) ?? [];
                    declarations.set(first.name, [...existing, ...optional]);
                }
            }
        }

        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const name = ts.isIdentifier(callee)
                ? callee.text
                : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
                  ? callee.name.text
                  : undefined;

            if (name !== undefined) {
                calls.push({
                    file: relativePath,
                    // Where the name comes from, so the match can be checked.
                    origin: bound.get(name) ?? relativePath,
                    name,
                    count: node.arguments.length,
                    text: node.getText().slice(0, 120),
                });
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(source);
}

/** A call that stops short of the function's last optional parameter. */
const findings: string[] = [];

for (const call of calls) {
    const optional = declarations.get(call.name);
    if (optional === undefined) continue;

    for (const candidate of optional) {
        // Origin first: the caller must have imported this name from this file.
        // Then the arity question.
        if (call.origin !== candidate.file) continue;

        // Only the trailing position matters: a call shorter than the index of
        // the parameter that would take it.
        if (call.count < candidate.index) {
            findings.push(
                `${candidate.file}  ${candidate.name}()  #${candidate.index}  ←  ${call.file}  передано ${call.count}`,
            );
        }
    }
}

/**
 * Printed through `process.stdout.write` rather than `console.log`.
 *
 * `noConsole` is switched off in `biome.json` for `*.cli.ts` and `server.ts`,
 * and this file is neither. Adding an override for it would be a repository-wide
 * configuration change made for one script; `performance.cli.ts` already
 * establishes that writing to stdout directly is acceptable here.
 */
const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
};

const unique = [...new Set(findings)].sort();

say(`Production files scanned: ${sources(root).length}`);
say(
    `Functions carrying an optional parameter: ${new Set([...declarations.keys()]).size}`,
);
say(`Call sites short of a trailing optional parameter: ${unique.length}`);
say('');

for (const line of unique) {
    say(`  ${line}`);
}

say('');
say('A candidate is not a finding. Read the parameter: if omitting it turns a');
say('check off rather than choosing a default, it belongs in the signature as a');
say('required argument with the default moved inside.');
