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
    permitsFile,
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
    }, 30000);

    it('does not count a bare package import as an internal edge', () => {
        const graphBuilt = buildGraph(realRoot);

        expect(graphBuilt.edges.every((e) => e.specifier.startsWith('.'))).toBe(true);
    }, 30000);

    it('scans the backend and nothing else', () => {
        const files = listSources(realRoot);

        expect(files.length).toBeGreaterThan(150);
        expect(files.every((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))).toBe(true);
        expect(files.some((f) => f.includes('test-support'))).toBe(false);
    }, 30000);

    it('reports the violations that remain, and pins them exactly', () => {
        // Eight, and pinned as a list rather than a count so that fixing one is
        // a visible edit. Two of them are the same inversion imported twice —
        // `history/ingestion.service.ts` reaches `services/poller.ts` with two
        // import statements — and three are the frozen contract.
        const found = violations(buildGraph(realRoot))
            .map((v) => `${v.from} → ${v.to}`)
            .sort();

        expect(found).toEqual([
            'config/strategy-fingerprint.ts → strategies/strategy-fingerprint.ts',
            'history/ingestion.service.ts → services/poller.ts',
            'history/ingestion.service.ts → services/poller.ts',
            'indicators/performance/indicator-performance.service.ts → history/bounded-write-buffer.ts',
            'indicators/performance/indicator-performance.service.ts → history/signal-history.service.ts',
            'strategies/types.ts → signals/signal.types.ts',
            'types/analysis.ts → indicators/divergence.service.ts',
            'types/analysis.ts → indicators/indicator.service.ts',
            'types/analysis.ts → signals/signal.types.ts',
        ]);
    }, 30000);

    it('reports no edge from a domain into the database', () => {
        // The one M2 existed to deliver, and it is already delivered: a
        // repository is the declared seam and may reach the pool, and there is
        // no service in this codebase that opens its own connection.
        const found = violations(buildGraph(realRoot))
            .map((v) => `${v.from} → ${v.to}`)
            .filter((edge) => edge.endsWith('→ db/pool.ts'));

        expect(found).toEqual([]);
    }, 30000);

    it('still reports the same edges when the seam is not consulted', () => {
        // `permits` is the layer rule on its own and is unchanged, so the seam
        // is an addition to it rather than a replacement — a table that quietly
        // stopped checking anything would be worse than no table.
        expect(permits('indicators', 'db')).toBe(false);
        expect(permitsFile('strategies/candidate.repository.ts', 'db/pool.ts')).toBe(true);
        expect(permitsFile('strategies/candidate.service.ts', 'db/pool.ts')).toBe(false);
    });

    it('finds the inversion that matters most: the wire contract importing code', () => {
        // `types/analysis.ts` is the frozen contract the frontend reads, and it
        // imports the indicator service and the signal types. The bottom layer
        // of the architecture depending on two of its middles means the contract
        // is not a contract — it moves whenever the implementation does.
        const found = violations(buildGraph(realRoot)).map((v) => `${v.from} → ${v.to}`);

        expect(found).toContain('types/analysis.ts → indicators/indicator.service.ts');
        expect(found).toContain('types/analysis.ts → signals/signal.types.ts');
    }, 30000);

    it('has no layer outside the table now', () => {
        expect(summarise(realRoot).unplaced).toEqual([]);
    }, 30000);

    it('finds no stranded layer, and would have', () => {
        // **This test was the finding.** It read: four modules, ten edges
        // between them, not one edge arriving from outside — `performance/`
        // calculated, and no production path called it. Only its own tests did,
        // and a test is not a caller. Four hundred and fifty-four lines of code
        // and a thousand one hundred and fifty-four lines of tests, with no way
        // to be asked a question.
        //
        // The roadmap put "performance aggregation" in M6 as work to do: this
        // was work that had been done, was tested, and was wired to nothing.
        // It is now reached by a reader and a command line, and the finding is
        // closed by the code rather than by declaring the layer a root — which
        // is the move that silences a finding instead of fixing one.
        //
        // Kept as a guard rather than deleted, because "nothing is stranded" is
        // a claim about the whole tree and it costs one call to check.
        const report = summarise(realRoot);

        expect(report.unreachable).toEqual([]);
    }, 30000);

    it('reaches the performance layer from a real caller, not from a root', () => {
        // If `performance` were counted reachable because something declared it
        // a composition root, the number above would be empty for the wrong
        // reason and this one is what would catch it.
        const report = summarise(realRoot);
        const row = report.byLayer.find((entry) => entry.layer === 'performance');

        expect(row?.in).toBeGreaterThan(0);
        expect(row?.inFrom).toEqual({ research: row?.in });
    }, 30000);

    it('does not report an entry point as stranded', () => {
        // `research` and `app.ts` have no callers because they are the things
        // you run. A rule that called them unreachable would be calling the
        // architecture broken, and would be switched off the first time it was
        // right about something else.
        const report = summarise(realRoot);
        const stranded = report.unreachable.map((row) => row.layer);

        expect(stranded).not.toContain('research');
        expect(stranded).not.toContain('app.ts');
        expect(stranded).not.toContain('api');
    }, 30000);

    it('does not count a layer talking to itself as a boundary', () => {
        // 240 of the 576 edges are within a layer. Counting them as input and
        // output would make every layer look like it had a wider surface than
        // the one it actually has, and the map would be decoration.
        const report = summarise(realRoot);
        const boundary = report.byLayer.reduce((total, row) => total + row.in, 0);

        expect(boundary).toBe(report.edges - report.internal);
    }, 30000);

    it('gives every layer an input and an output, even a leaf with none', () => {
        for (const row of summarise(realRoot).byLayer) {
            expect(typeof row.in).toBe('number');
            expect(typeof row.out).toBe('number');
        }
    }, 30000);

    it('has no cycle between layers', () => {
        expect(summarise(realRoot).cycle).toBeNull();
    }, 30000);

    it('knows layerOf reads a directory, not a file', () => {
        expect(layerOf('market/providers/binance.provider.ts')).toBe('market');
        expect(layerOf('app.ts')).toBe('app.ts');
    });
});
