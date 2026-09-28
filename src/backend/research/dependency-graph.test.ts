import { describe, expect, it } from 'vitest';

import {
    LAYERS,
    UNPLACED,
    UNIVERSAL,
    buildGraph,
    findCycle,
    layerOf,
    listSources,
    permits,
    summarise,
    violations,
} from './dependency-graph.js';

import type { Graph } from './dependency-graph.js';
import { join } from 'node:path';

const realRoot = join(process.cwd(), 'src', 'backend');

const edge = (from: string, to: string, internal = false) => ({
    from,
    to,
    specifier: './x.js',
    line: 1,
    internal,
});

const graph = (...edges: ReturnType<typeof edge>[]): Graph => ({ edges, files: 2 });

describe('a layer may do what it declared, and nothing else', () => {
    it('lets a core layer import what its declaration lists', () => {
        expect(permits('history', 'db')).toBe(true);
        expect(permits('history', 'market')).toBe(true);
    });

    it('stops a core layer importing what it did not declare', () => {
        // The rule PHASE 46 names first: the database is not something the
        // indicators may reach. Whether this codebase obeys is a separate
        // question, and it is answered by the audit rather than the rule.
        expect(permits('indicators', 'db')).toBe(false);
        expect(permits('strategies', 'market')).toBe(false);
    });

    it('lets a composing layer import anything, because composing is its job', () => {
        // The first version of this table declared a total order from the
        // roadmap's pipeline and reported two hundred violations, every one of
        // them an HTTP controller doing what an HTTP controller is for.
        expect(permits('api', 'market')).toBe(true);
        expect(permits('services', 'db')).toBe(true);
        expect(permits('research', 'types')).toBe(true);
    });

    it('lets anything count things through observability', () => {
        // A layer that may not be instrumented is a layer nobody can operate,
        // and putting instrumentation at the top of an order says it is a
        // destination. It is a leaf that many layers happen to hold.
        expect(UNIVERSAL).toContain('observability');
        expect(permits('db', 'observability')).toBe(true);
        expect(permits('market', 'observability')).toBe(true);
    });

    it('lets a layer import itself and the universal leaves, undeclared', () => {
        expect(permits('market', 'market')).toBe(true);
        expect(permits('market', 'types')).toBe(true);
        expect(permits('market', 'errors')).toBe(true);
        expect(permits('market', 'config')).toBe(true);
    });

    it('refuses a layer that has no declaration rather than guessing one', () => {
        // Assigning a rank to an unplaced layer is a decision. A check that
        // made the decision itself would be checking its own output.
        expect(permits('nonsense', 'db')).toBe(false);
    });

    it('treats an entry point as composing without needing a full declaration', () => {
        expect(permits('app.ts', 'market')).toBe(true);
        expect(UNPLACED['app.ts']).toBe('composition');
    });
});

describe('the layer table is a decision, and is pinned', () => {
    it('declares each layer exactly once', () => {
        const names = LAYERS.map((layer) => layer.name);

        expect(new Set(names).size).toBe(names.length);
    });

    it('never lists a layer that does not exist in the table', () => {
        for (const layer of LAYERS) {
            for (const target of layer.mayImport) {
                expect(LAYERS.some((entry) => entry.name === target)).toBe(true);
            }
        }
    });

    it('gives every layer a kind, so a leaf is never quietly assumed composing', () => {
        for (const layer of LAYERS) {
            expect(typeof layer.composition).toBe('boolean');
        }
    });
});

describe('a cycle is named, not merely announced', () => {
    it('finds one and shows the way round', () => {
        const found = findCycle(
            graph(edge('a/x.ts', 'b/y.ts'), edge('b/y.ts', 'a/x.ts')),
            false,
        );

        expect(found).not.toBeNull();
        expect(found?.files).toHaveLength(2);
    });

    it('finds a cycle inside one layer, which is a different defect', () => {
        // A core layer reaching where it should not is one bug. Two modules in
        // one layer depending on each other is another: what each has at module
        // load time is decided by the order they happen to load in.
        const found = findCycle(
            graph(
                edge('backtest/walk-forward.ts', 'backtest/walk-forward.plan.ts', true),
                edge('backtest/walk-forward.plan.ts', 'backtest/walk-forward.ts', true),
            ),
            true,
        );

        expect(found).not.toBeNull();
        expect(findCycle(graph(edge('a/x.ts', 'b/y.ts')), true)).toBeNull();
    });

    it('reports no cycle in a chain that only goes one way', () => {
        expect(
            findCycle(
                graph(edge('a/x.ts', 'b/y.ts'), edge('b/y.ts', 'c/z.ts'), edge('c/z.ts', 'd/w.ts')),
                false,
            ),
        ).toBeNull();
    });

    it('does not mistake a diamond for a cycle', () => {
        // A and B both reaching D is not a loop, and a check that said so would
        // be the kind of false alarm that gets a real report ignored.
        expect(
            findCycle(
                graph(
                    edge('a/x.ts', 'c/d.ts'),
                    edge('b/y.ts', 'c/d.ts'),
                    edge('c/d.ts', 'e/f.ts'),
                ),
                false,
            ),
        ).toBeNull();
    });
});

describe('this codebase, measured', () => {
    it('resolves an ESM specifier to the .ts file on disk', () => {
        // Sources import `./x.js`; a graph that missed those would report a
        // clean, empty, entirely fictional architecture.
        const graphBuilt = buildGraph(realRoot);
        const resolved = graphBuilt.edges.filter((e) => e.specifier.startsWith('.'));

        expect(resolved.length).toBeGreaterThan(100);
        expect(graphBuilt.edges.every((e) => e.to.endsWith('.ts'))).toBe(true);
    });

    it('does not count a bare package import as an internal edge', () => {
        const graphBuilt = buildGraph(realRoot);

        expect(graphBuilt.edges.every((e) => e.specifier.startsWith('.'))).toBe(true);
    });

    it('scans the backend and nothing else', () => {
        const files = listSources(realRoot);

        expect(files.length).toBeGreaterThan(150);
        expect(files.every((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))).toBe(true);
        expect(files.some((f) => f.includes('test-support'))).toBe(false);
    });

    it('finds the violations the roadmap names, and pins them', () => {
        // These are the real edges, and they are the ones PHASE 46 lists as
        // forbidden. Pinned so that fixing one is a deliberate edit rather than
        // a number that quietly improves.
        const found = violations(buildGraph(realRoot)).map(
            (v) => `${v.from} → ${v.to}`,
        );

        expect(found).toContain('indicators/performance/indicator-vote.repository.ts → db/pool.ts');
        expect(found).toContain('history/ingestion.service.ts → services/poller.ts');
        expect(found).toContain('config/strategy-fingerprint.ts → strategies/strategy-fingerprint.ts');
    });

    it('finds the inversion that matters most: the wire contract importing code', () => {
        // `types/analysis.ts` is the frozen contract the frontend reads, and it
        // imports the indicator service and the signal types. The bottom layer
        // of the architecture depending on two of its middles means the contract
        // is not a contract — it moves whenever the implementation does.
        const found = violations(buildGraph(realRoot)).map((v) => `${v.from} → ${v.to}`);

        expect(found).toContain('types/analysis.ts → indicators/indicator.service.ts');
        expect(found).toContain('types/analysis.ts → signals/signal.types.ts');
    });

    it('has no layer outside the table now', () => {
        expect(summarise(realRoot).unplaced).toEqual([]);
    });

    it('has no cycle between layers', () => {
        expect(summarise(realRoot).cycle).toBeNull();
    });

    it('knows layerOf reads a directory, not a file', () => {
        expect(layerOf('market/providers/binance.provider.ts')).toBe('market');
        expect(layerOf('app.ts')).toBe('app.ts');
    });
});
