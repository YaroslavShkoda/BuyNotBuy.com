/**
 * The dependency graph, and the cycles in it.
 *
 * PHASE 46 lists "no circular dependencies" as an architectural lint rule, and
 * M0 lists a dependency graph as a baseline deliverable. They are the same
 * measurement, so this builds it once and answers both.
 *
 * **The layers the roadmap asks for, as data.** PHASE 0 draws a chain —
 *
 *     Provider → Market → Indicators → Analysis → Signal → Snapshot
 *     → History → Outcome → Performance → Research
 *
 * — and PHASE 46 gives four forbidden edges to police it. A layer table is
 * what makes those checkable: without an explicit declaration of which layer
 * may import which, "no circular dependencies" is either vacuous or a rule
 * someone enforces from memory.
 *
 * **The rule is a total order, and that is what does the work.** A cycle is
 * only a cycle relative to an allowed direction. Acyclicity alone is satisfied
 * by an arbitrary, meaningless topology; acyclicity *plus* a declared layering
 * means every edge points one way, so a violation names a specific wrong
 * direction rather than just "there is a loop somewhere".
 *
 * A `research` → `production` edge is the one the roadmap calls out and the one
 * that matters most here. Research is allowed to import anything, because
 * measurement is allowed to look at everything. Production importing research
 * is the other thing entirely: a backtest helper reaching into a live rule is
 * how a module ends up with an execution model it did not choose, which is the
 * exact defect that voided every number in this project earlier.
 *
 * Counted, not judged. This reports what is true of the codebase as it is on
 * the day it runs; the roadmap's milestones change it, and the report is how
 * that change is seen rather than assumed.
 */


import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript-5';

const SKIPPED = new Set(['test-support', 'node_modules', '.next', 'fixtures']);

/**
 * The layers, and who may import whom.
 *
 * **The first version of this file got this wrong, and the data said so.** The
 * roadmap draws a chain — Provider → Market → Indicators → Analysis → Signal →
 * Snapshot — and the first model here read it as a total order with `api` on
 * top, which made `api → market` and `api → history` look like two hundred
 * violations. They are not violations. They are what an HTTP adapter is.
 *
 * That chain is a *flow of data*, not a list of dependencies. A layer moves
 * data downward; it may also call downward, upward-adjacent, or sideways. What
 * is actually forbidden is narrower and is what PHASE 46 names: the database
 * below the indicators, the provider below the strategy, research below
 * production, and a cycle.
 *
 * So the rule is an explicit table, and a table can be wrong in a way that
 * shows up. Two kinds of layer:
 *
 *   - **core** — holds a decision. May import what it declares, and no more.
 *   - **composition** — wires things together. May import anything, because
 *     that is the job; `api`, `services`, `research` and the entry points have
 *     no business being told what they may not wire.
 *
 * `types`, `errors` and `config` are available everywhere, which is why they
 * are not in any layer's list. `config` reads the environment and is a leaf by
 * design: it imports nothing, so a module importing it can never pull a
 * dependency in through the back door.
 */
interface Layer {
    readonly name: string;
    readonly composition: boolean;
    /** Layers this one may import. Empty means a leaf. */
    readonly mayImport: readonly string[];
}

const TYPES = 'types';
const ERRORS = 'errors';
const CONFIG = 'config';

/**
 * Importable from anywhere: leaves with no decisions of their own.
 *
 * `observability` is here rather than in the table, and that placement is a
 * finding rather than a convenience. The first table put it at the top as a
 * composing layer, on the assumption that instrumentation is a destination.
 * It is not: `db/pool.ts`, `indicators/indicator.service.ts`,
 * `market/market.service.ts`, `signals/signal-publication.ts` and
 * `backtest/backtest.service.ts` all import its registry, and every one of them
 * was reported as breaking the layering. What they actually import is a
 * counter, and a layer that may not be counted is a layer nobody can operate.
 * Cross-cutting concerns are leaves, not destinations.
 */
export const UNIVERSAL: readonly string[] = [
    TYPES,
    ERRORS,
    CONFIG,
    'instruments',
    'observability',
];

export const LAYERS: readonly Layer[] = [
    { name: TYPES, composition: false, mayImport: [] },
    { name: ERRORS, composition: false, mayImport: [] },
    // May import `instruments`, and the edge is the honest description of what
    // the code does: a market setting is only usable if the asset registry can
    // split it, so the registry is an input to whether the config is valid.
    // Without that edge a bad symbol passed validation and the failure arrived
    // from a venue as an HTTP 400 hours later.
    //
    // May also import `strategies`, and this one is said out loud because a
    // config that imports a strategy looks exactly like the mistake this table
    // exists to prevent.
    //
    // `config/strategy-fingerprint.ts` reads `STRATEGY_FACTORIES` so that
    // installing a rule moves the configuration hash. Without it the hash would
    // stay the same, no new `strategy_version` row would appear, and every
    // signal after that point would be filed under a configuration in which the
    // new rule does not exist — the exact failure the fingerprint was built to
    // prevent, reintroduced by the list that feeds it.
    //
    // The alternative is not "no edge", it is `strategies → config`, which is
    // what the registry and every strategy module already do. Both together is
    // a cycle: config → strategies → indicators → config. A cycle is a worse
    // defect than a declared edge, and it fails as an undefined binding at
    // startup rather than as a compile error, which is the worst way for a
    // build to fail. The fingerprint is already split into its own file for
    // precisely this reason.
    //
    // So the edge is declared rather than removed. A table that can only say
    // "forbidden" cannot describe a trade-off somebody actually made, and the
    // next reader would either re-add the import or delete the fingerprint —
    // both worse than the edge being visible here.
    { name: CONFIG, composition: false, mayImport: ['instruments', 'strategies'] },
    // A pure leaf. No I/O, no database, no clock — which is what lets its
    // tests prove something about parsing rather than about a connection.
    //
    // `db` and `config` are declared here, and the declaration is the point: a
    // repository in a domain folder is the M2 debt this project already has in
    // `indicators`, `strategies` and `signals`, and the rule for M2 is that all
    // four move to a data layer together. Recording it costs one line and names
    // the debt; leaving it out would produce a fourteenth violation with no
    // name attached, discovered by a guard rather than chosen by a person.
    //
    // The purity worth protecting is `instruments/domain.ts`, which is what
    // those two imports are kept out of.
    { name: 'instruments', composition: false, mayImport: ['db', 'config'] },
    { name: 'db', composition: false, mayImport: [] },
    { name: 'market', composition: false, mayImport: ['db'] },
    { name: 'indicators', composition: false, mayImport: [] },
    { name: 'strategies', composition: false, mayImport: [] },
    { name: 'signals', composition: false, mayImport: ['indicators', 'strategies'] },
    {
        name: 'history',
        composition: false,
        mayImport: ['db', 'market', 'signals', 'strategies'],
    },
    { name: 'outcomes', composition: false, mayImport: ['db', 'market', 'signals'] },
    { name: 'performance', composition: false, mayImport: ['outcomes', 'signals'] },
    { name: 'analysis', composition: false, mayImport: ['db', 'strategies'] },
    { name: 'backtest', composition: false, mayImport: ['db', 'market', 'indicators', 'signals', 'strategies'] },
    { name: 'services', composition: true, mayImport: [] },
    { name: 'api', composition: true, mayImport: [] },
    { name: 'research', composition: true, mayImport: [] },
    // In UNIVERSAL because everything may count things through it, and
    // declared because a health check that cannot ask the database whether the
    // database is up is a health check that only reports on the code.
    { name: 'observability', composition: false, mayImport: ['db'] },
];

/** Entry points and modules the roadmap does not name a layer for. */
export const UNPLACED: Readonly<Record<string, 'composition' | 'core'>> = {
    'app.ts': 'composition',
    'server.ts': 'composition',
    // Split out of `server.ts` when the file had become a runtime
    // orchestrator, and composition for the same reason its parent was:
    // bootstrap wires the schema check, the spool replay, the registry seed,
    // the market loops and the shutdown order together, and a wiring layer
    // that may not wire is a process that may not start. It holds no
    // decisions of its own — every decision it touches lives in the layer
    // that already owned it.
    'bootstrap': 'composition',
    // Renamed from `strategy` to `lifecycle`, and the rename is the whole entry:
    // it was never a declared layer, so nothing in LAYERS moves and no edge
    // changes. What it holds is what happens to a record of a rule — the ladder
    // engine, the promotion policy, the evidence a promotion requires — and
    // that is not a rule, which is what `strategies/` is. Two directories one
    // letter apart, each with a registry of rules in it, was the trap.
    'lifecycle': 'core',
    'properties': 'core',
};

export function layerOf(relativePath: string): string {
    return relativePath.split(/[\\/]/)[0] ?? '';
}

function declarationOf(layer: string): Layer | undefined {
    return LAYERS.find((entry) => entry.name === layer);
}

type ViolationKind = 'forbidden-layer' | 'unplaced-layer';

interface Edge {
    readonly from: string;
    readonly to: string;
    /** The import specifier, kept so a report can point at the line. */
    readonly specifier: string;
    readonly line: number;
    /** A relative import within the same layer. */
    readonly internal: boolean;
}

/** Edges a declared layer is not allowed to have. */
interface Violation extends Edge {
    readonly kind: ViolationKind;
    readonly reason: string;
}

export function listSources(root: string): string[] {
    const found: string[] = [];

    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory)) {
            if (SKIPPED.has(entry)) {
                continue;
            }

            const full = join(directory, entry);

            if (statSync(full).isDirectory()) {
                walk(full);
            } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
                found.push(full);
            }
        }
    };

    walk(root);

    return found.sort();
}

function moduleSpecifierOf(node: ts.Node, source: ts.SourceFile): string | null {
    if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
    ) {
        return node.moduleSpecifier.text;
    }

    // `import type { X } from` and bare `import './side-effect'` are both
    // ImportDeclarations, but a dynamic `await import()` and a `require` in a
    // CJS-shaped test are not. A graph that silently drops those would report
    // a clean acyclic answer over an incomplete graph.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments;

        if (argument && ts.isStringLiteral(argument)) {
            return argument.text;
        }
    }

    void source;

    return null;
}

/** Resolves a relative specifier to a file inside the root, if it is one. */
function resolveInternal(
    specifier: string,
    fromFile: string,
    root: string,
    known: ReadonlySet<string>,
): string | null {
    if (!specifier.startsWith('.')) {
        return null;
    }

    // ESM here, so the source says `.js` for a file that is `.ts` on disk.
    const base = resolve(dirname(fromFile), specifier).replace(/\.js$/, '.ts');

    for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
        if (known.has(candidate)) {
            return candidate;
        }
    }

    return null;
}

export interface Graph {
    readonly edges: readonly Edge[];
    readonly files: number;
}

export function buildGraph(root: string): Graph {
    const files = listSources(root);
    const known = new Set(files);
    const edges: Edge[] = [];

    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        const relativePath = relative(root, file).split(sep).join('/');
        const source = ts.createSourceFile(
            relativePath,
            text,
            ts.ScriptTarget.Latest,
            /* setParentNodes */ true,
        );

        const visit = (node: ts.Node): void => {
            const specifier = moduleSpecifierOf(node, source);

            if (specifier) {
                const target = resolveInternal(specifier, file, root, known);

                if (target) {
                    const targetRelative = relative(root, target).split(sep).join('/');
                    const { line } = source.getLineAndCharacterOfPosition(
                        node.getStart(source),
                    );

                    edges.push({
                        from: relativePath,
                        to: targetRelative,
                        specifier,
                        line: line + 1,
                        internal: layerOf(relativePath) === layerOf(targetRelative),
                    });
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(source);
    }

    return { edges, files: files.length };
}

/**
 * Whether one layer may import another, as declared.
 *
 * Composition layers may import anything, because composing is their job and
 * forbidding it would be forbidding the layer from existing. A core layer may
 * import only what its declaration lists, plus the universal leaves. A layer
 * that has no declaration is reported rather than assumed — giving it a rank is
 * a decision, and a check that made the decision itself would be checking
 * nothing.
 */
export function permits(from: string, to: string): boolean {
    if (from === to || UNIVERSAL.includes(to)) {
        return true;
    }

    if (UNPLACED[from] === 'composition') {
        return true;
    }

    const declaration = declarationOf(from);

    if (!declaration) {
        return false;
    }

    return declaration.composition || declaration.mayImport.includes(to);
}

function reasonFor(from: string, to: string): string {
    const declaration = declarationOf(from);

    if (!declaration) {
        return `у слоя «${from}» нет объявления в таблице слоёв`;
    }

    if (declaration.composition) {
        return 'составляющий слой не должен выходить за пределы состава';
    }

    return `«${from}» объявлен с доступом к [${declaration.mayImport.join(', ') || 'ничего'}] и не объявлен с доступом к «${to}»`;
}

/**
 * Whether one file may import another, which the layer model alone cannot say.
 *
 * **A repository may reach the database from wherever it lives.** The layer
 * table works in layer names, so it could not tell a service that opens its own
 * connection from a repository that exists in order to — and it reported both
 * as the same violation. Measured: all eleven files outside `db/` that touch
 * the database are ten repositories and one health check, and every one of the
 * ten has tests. There is no service in this codebase that writes SQL.
 *
 * So the seam is now declared rather than moved. M2's plan was to relocate ten
 * repositories into `db/`, which would have been forty-four import sites and
 * no change to what the rule protects — the caller still imports the
 * implementation, and `layering-lint` still finds the same eleven files.
 */
function permitsEdge(edge: Edge): boolean {
    return permitsFile(edge.from, edge.to);
}

export function permitsFile(from: string, to: string): boolean {
    if (isRepository(from) && layerOf(to) === 'db') {
        return true;
    }

    return permits(layerOf(from), layerOf(to));
}

/** A repository is the declared seam between a domain and the database. */
function isRepository(file: string): boolean {
    return file.endsWith('.repository.ts');
}

/** Edges that a declared layer is not allowed to have. */
export function violations(graph: Graph): Violation[] {
    return graph.edges
        .filter((edge) => !edge.internal)
        .filter((edge) => !permitsEdge(edge))
        .map((edge) => ({
            ...edge,
            kind: (
                !declarationOf(layerOf(edge.from)) || !declarationOf(layerOf(edge.to))
                    ? 'unplaced-layer'
                    : 'forbidden-layer'
            ) as ViolationKind,
            reason: reasonFor(layerOf(edge.from), layerOf(edge.to)),
        }));
}

/** Layers with no declared place, which the roadmap does not name at all. */
function unplacedLayers(graph: Graph): string[] {
    const seen = new Set<string>();

    for (const edge of graph.edges) {
        for (const file of [edge.from, edge.to]) {
            const layer = layerOf(file);

            if (!declarationOf(layer) && UNPLACED[layer] === undefined) {
                seen.add(layer);
            }
        }
    }

    return [...seen].sort();
}

/** A real cycle, found by depth-first search — not "a loop somewhere". */
export function findCycle(graph: Graph, internal = false): Cycle | null {
    const adjacency = new Map<string, Edge[]>();

    for (const edge of graph.edges) {
        if (edge.internal !== internal) {
            continue;
        }

        const list = adjacency.get(edge.from) ?? [];
        list.push(edge);
        adjacency.set(edge.from, list);
    }

    const state = new Map<string, 0 | 1 | 2>();
    const stack: string[] = [];
    const trail: Edge[] = [];
    let found: Cycle | null = null;

    const visit = (node: string): void => {
        if (found) {
            return;
        }

        state.set(node, 1);
        stack.push(node);

        for (const edge of adjacency.get(node) ?? []) {
            if (found) {
                break;
            }

            const next = edge.to;

            if (state.get(next) === 1) {
                const cut = stack.indexOf(next);
                found = {
                    files: stack.slice(cut),
                    edges: [...trail.slice(cut), edge],
                };
                break;
            }

            if (state.get(next) === undefined) {
                trail.push(edge);
                visit(next);
                trail.pop();
            }
        }

        stack.pop();
        state.set(node, 2);
    };

    for (const node of [...adjacency.keys()].sort()) {
        if (state.get(node) === undefined && !found) {
            visit(node);
        }
    }

    return found;
}

interface LayerRow {
    readonly layer: string;
    readonly files: number;
    /** Edges leaving the layer. This is the layer's output. */
    readonly out: number;
    /** Edges entering the layer. This is the layer's input. */
    readonly in: number;
    /** Outgoing edges to each named layer, in name order. */
    readonly outTo: Readonly<Record<string, number>>;
    /** Incoming edges from each named layer, in name order. */
    readonly inFrom: Readonly<Record<string, number>>;
}

interface Summary {
    readonly files: number;
    readonly edges: number;
    readonly internal: number;
    readonly byLayer: readonly LayerRow[];
    /**
     * Core layers that do something and that nothing reaches.
     *
     * Composition layers and entry points are excluded, and the exclusion is
     * the point rather than a convenience: `research` and `app.ts` have no
     * callers because they are the things you run, and a rule that reported
     * them as stranded would be reporting the architecture working. A core
     * layer with zero inbound edges is a different claim — it calculates, it
     * is tested, and there is no path from production to it.
     */
    readonly unreachable: readonly LayerRow[];
    readonly violations: readonly Violation[];
    readonly unplaced: readonly string[];
    readonly cycle: Cycle | null;
    readonly internalCycle: Cycle | null;
}

interface Cycle {
    readonly files: readonly string[];
    readonly edges: readonly Edge[];
}

/** Adds one to a tally. Counts belong in one place, not at every call site. */
const tally = (into: Map<string, number>, key: string): void => {
    into.set(key, (into.get(key) ?? 0) + 1);
};

const sorted = (into: Map<string, number>): Record<string, number> =>
    Object.fromEntries([...into.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

export function summarise(root: string): Summary {
    const graph = buildGraph(root);

    const filesInLayer = new Map<string, Set<string>>();
    const outTo = new Map<string, Map<string, number>>();
    const inFrom = new Map<string, Map<string, number>>();
    const outCount = new Map<string, number>();
    const inCount = new Map<string, number>();

    for (const edge of graph.edges) {
        for (const file of [edge.from, edge.to]) {
            const layer = layerOf(file);
            const set = filesInLayer.get(layer) ?? new Set<string>();

            set.add(file);
            filesInLayer.set(layer, set);
        }

        // An edge inside a layer is that layer talking to itself, and counting
        // it as both its input and its output would make every layer look
        // busier than the boundary it actually has.
        if (edge.internal) {
            continue;
        }

        const from = layerOf(edge.from);
        const to = layerOf(edge.to);

        tally(outCount, from);
        tally(inCount, to);

        const outMap = outTo.get(from) ?? new Map<string, number>();

        tally(outMap, to);
        outTo.set(from, outMap);

        const inMap = inFrom.get(to) ?? new Map<string, number>();

        tally(inMap, from);
        inFrom.set(to, inMap);
    }

    const byLayer = [...filesInLayer.keys()].sort().map((layer) => ({
        layer,
        files: filesInLayer.get(layer)?.size ?? 0,
        out: outCount.get(layer) ?? 0,
        in: inCount.get(layer) ?? 0,
        outTo: sorted(outTo.get(layer) ?? new Map<string, number>()),
        inFrom: sorted(inFrom.get(layer) ?? new Map<string, number>()),
    }));

    const isComposition = (layer: string): boolean =>
        declarationOf(layer)?.composition === true || UNPLACED[layer] === 'composition';

    return {
        files: graph.files,
        edges: graph.edges.length,
        internal: graph.edges.filter((edge) => edge.internal).length,
        byLayer,
        unreachable: byLayer.filter((row) => row.in === 0 && row.out > 0 && !isComposition(row.layer)),
        violations: violations(graph),
        unplaced: unplacedLayers(graph),
        cycle: findCycle(graph, false),
        internalCycle: findCycle(graph, true),
    };
}
