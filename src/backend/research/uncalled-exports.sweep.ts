/**
 * Sweep: exported functions that nothing in production calls.
 *
 * **The module-level check cannot see this, and the gap is not academic.**
 * `research/stranded-modules.test.ts` pins the production modules with no
 * production caller — `strategy/rule-registry.ts` and `strategy/promotion.config.ts`,
 * 572 lines of rule lifecycle — and that is exactly the right unit for what
 * stranded: a whole file nobody reaches. The dependency graph reports zero
 * unreachable layers for the same reason.
 *
 * But a reachable file can hold an unreachable function, and the owner's fourth
 * decision is about one: `promote()` is the promotion gate, it is the subject of
 * the question "where do we store the reason for a refusal", and by my own
 * measurement it has no production call site at all — only tests. Its module is
 * reachable, so neither existing check reports it.
 *
 * Both measurements are right about their own subject. This one is about the
 * finer grain, so that the size of the question is a number rather than an
 * impression.
 *
 * Names are bound to their origin file before matching, and a call counts only
 * where the caller imported that name from that file. The first version of the
 * sibling sweep matched by bare identifier and matched every `Number(...)` call
 * in the codebase against an unrelated `number()` helper, which is how a tool
 * ends up reporting a category that cannot exist.
 *
 * **Three things this tool got wrong on the first run, and all three inflated
 * the number rather than shrinking it.**
 *
 * 1. One pass. Declarations and calls were collected together, so a function
 *    called above its own declaration was reported as uncalled — `sum` in
 *    `indicators/adx.ts` is called three times at lines 101, 102 and 151 and
 *    declared at 201, and the sweep called it stranded. A tool that invents
 *    findings teaches the reader to discount it, which costs more than having
 *    no tool. Two passes now: declarations first, then references.
 * 2. Everything counted. A private helper called only inside its own file is
 *    not an exported API with no customer. Restricting the report to `export`
 *    declarations took 152 to 62.
 * 3. "No call" read as "no reference". An export imported under another name —
 *    `getPrice` arrives as `getMarketPrice` in `api/controllers/price.controller.ts`
 *    — is used. And an export passed as a value rather than called —
 *    `app.register(instrumentRoutes)` — is used too. Both are counted now, which
 *    is the difference between a caller and an identifier that happens to share
 *    a spelling.
 *
 * The residue is 62 names with no production call and no production import, and
 * the report splits them by what they are instead of printing one number: a
 * caller-less export whose module nobody namespaces in, and a blind spot this
 * tool cannot close without types.
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

interface Declared {
    file: string;
    name: string;
    /** True for a default export, which a caller reaches by import shape. */
    anonymous: boolean;
}

const declared = new Map<string, Declared[]>();
/** Every declared name, exported or not: a private helper called in its own file is reachable. */
const declaredNames = new Set<string>();
const called = new Set<string>();
/** Imported and used as a value rather than invoked: `app.register(routes)`. */
const passed = new Set<string>();
/** Modules somebody imports as a namespace, where member access is unresolvable here. */
const namespaced = new Set<string>();

const normalise = (path: string): string =>
    relative(root, path.replace(/\.js$/, '.ts')).split(sep).join('/');

function readSource(file: string): ts.SourceFile {
    return ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );
}

/** Local binding name to the module it came from. */
function importOrigins(source: ts.SourceFile, file: string): Map<string, string> {
    const bound = new Map<string, string>();

    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        if (statement.importClause === undefined) continue;

        const specifier = statement.moduleSpecifier;
        if (!ts.isStringLiteral(specifier)) continue;

        const from = normalise(join(dirname(file), specifier.text));
        const clause = statement.importClause;

        if (clause.name !== undefined) bound.set(clause.name.text, from);

        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
            // `import * as market` reaches every member. This tool cannot count
            // those calls, so the module is recorded and reported as a blind spot
            // rather than guessed at.
            namespaced.add(from);
        } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                bound.set(element.name.text, from);
            }
        }
    }

    return bound;
}

const scanned = sources(root);

// Pass one: every declaration, so a call above its declaration still resolves.
for (const file of scanned) {
    const relativePath = normalise(file);
    const source = readSource(file);

    const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
            const exported =
                node.modifiers?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
                ) === true;
            const isDefault =
                node.modifiers?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
                ) === true;

            declaredNames.add(node.name.text);

            // Only exported names are this tool's subject. A private helper with
            // no caller is either dead or about to be, and neither is a fact
            // about the module's public surface.
            if (exported) {
                const existing = declared.get(node.name.text) ?? [];
                existing.push({ file: relativePath, name: node.name.text, anonymous: isDefault });
                declared.set(node.name.text, existing);
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(source);
}

// Pass two: every reference to a declared name.
for (const file of scanned) {
    const relativePath = normalise(file);
    const source = readSource(file);
    const origin = importOrigins(source, file);

    /** The module a bare identifier in this file refers to, if any. */
    const where = (name: string): string | undefined => {
        const from = origin.get(name);
        if (from !== undefined) return from;
        return declaredNames.has(name) ? relativePath : undefined;
    };

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const from = where(node.expression.text);
            if (from !== undefined) called.add(`${from} ${node.expression.text}`);
        }

        if (ts.isIdentifier(node)) {
            const parent = node.parent;

            // Positions where the identifier is a spelling of something else: a
            // declaration, a property name, an import clause, a parameter.
            const isOwnName =
                ((ts.isFunctionDeclaration(parent) ||
                    ts.isVariableDeclaration(parent)) &&
                    parent.name === node) ||
                ts.isParameter(parent) ||
                ts.isImportClause(parent) ||
                ts.isImportSpecifier(parent) ||
                ts.isNamespaceImport(parent) ||
                ((ts.isPropertyAccessExpression(parent) ||
                    ts.isPropertyAssignment(parent)) &&
                    parent.name === node) ||
                (ts.isCallExpression(parent) && parent.expression === node);

            if (!isOwnName) {
                const from = where(node.text);
                if (from !== undefined) passed.add(`${from} ${node.text}`);
            }
        }

        // Member calls are not resolved: `service.promote()` cannot be attributed
        // to a file without types, and guessing would produce exactly the false
        // assurance this sweep exists to avoid.
        ts.forEachChild(node, visit);
    };

    visit(source);
}

const key = (entry: Declared): string => `${entry.file} ${entry.name}`;

const exported = [...declared.values()]
    .flat()
    .filter((entry) => !entry.anonymous);

const stranded = exported
    .filter((entry) => !called.has(key(entry)) && !passed.has(key(entry)))
    .sort((a, b) => key(a).localeCompare(key(b)));

const unreachable = stranded.filter((entry) => !namespaced.has(entry.file));
const blindSpot = stranded.filter((entry) => namespaced.has(entry.file));

const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
};

say(`Production files scanned: ${scanned.length}`);
say(`Exported functions declared: ${exported.length}`);
say(`With no production call site: ${unreachable.length}`);
say('');
say('  module-level stranding is covered by research/stranded-modules.test.ts.');
say('  This list is the finer grain and does not overlap it in purpose.');
say('');

const byFile = new Map<string, string[]>();
for (const entry of unreachable) {
    byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry.name]);
}

for (const file of [...byFile.keys()].sort()) {
    say(`  ${file}`);
    say(`      ${(byFile.get(file) ?? []).join(', ')}`);
}

say('');
say(`Blind spot: ${blindSpot.length} exports in modules somebody imports as a`);
say('namespace. Member access cannot be attributed to a file without types, so');
say('these are reported as unknown rather than as stranded:');
for (const file of [...new Set(blindSpot.map((entry) => entry.file))].sort()) {
    say(`  ${file}`);
    say(`      ${blindSpot.filter((entry) => entry.file === file).map((entry) => entry.name).join(', ')}`);
}

say('');
say('An export reached as an object method — a repository returned by a factory,');
say('for instance — is also invisible here. That is the known case behind the');
say("owner's fourth decision: `promote()` is called, if anywhere, as a method.");
say('A sweep that hides its own gaps reads as a cleaner result than the code deserves.');