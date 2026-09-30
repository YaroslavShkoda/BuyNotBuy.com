import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGraph, listSources } from './dependency-graph.js';

const realRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Production modules that nothing in production imports.
 *
 * This is the module-level counterpart to the layer-level `unreachable` check
 * in the dependency graph, and it exists because a whole promotion subsystem
 * turned out to be invisible from this side. `strategy/rule-registry.ts` and
 * `strategy/promotion.config.ts` together hold 572 lines of rule lifecycle —
 * `createRule`, `productionRules`, `activeRule`, `auditProduction`, `advance`,
 * `planRollback` and the whole `RuleStage` ladder — and the only file in the
 * repository that imports either of them is their own test, 545 lines long.
 *
 * That is not a bug on its own. A test can be the first customer of a module
 * somebody is building, and deleting someone's deliberate policy on the grounds
 * that it is unused is a decision and not a measurement. What was not acceptable
 * was that nobody could *see* it: the layer report said every layer was
 * reachable, and the architecture lint said zero violations, and both were true
 * while a second promotion ladder sat in the tree with no callers at all.
 *
 * **The list is pinned on purpose.** If somebody wires the registry up, this
 * test fails and says so — which is the moment to delete it deliberately,
 * having used it, rather than to leave two ladders to drift apart in silence.
 * That drift is not hypothetical: the two disagree about whether a rule may be
 * retired from any stage, whether retirement is permanent, and whether
 * `rejected` is a state at all.
 */
describe('production modules with no production caller', () => {
    it('leaves the code that nothing in production reaches', () => {
        const graph = buildGraph(realRoot);
        const sources = listSources(realRoot);

        // Sources come back as absolute paths and edges as root-relative ones
        // with forward slashes. My first version compared one against the other
        // and matched nothing, which reported all 185 files as stranded — a
        // number that looked like a finding and was entirely a bug of mine. The
        // two shapes are made comparable here, explicitly, so the check below
        // is about the graph rather than about path formatting.
        const relative = (absolute: string): string =>
            absolute
                .slice(realRoot.length)
                .replace(/^[\\/]/, '')
                .split('\\')
                .join('/');

        // The graph is built over everything, so an edge from a test file is a
        // test file's business, not a production one.
        const isTest = (file: string): boolean => file.includes('.test.');

        /**
         * Being an entry point is not being stranded.
         *
         * Twenty-seven of the thirty-eight matches are a command line, the
         * server, or the research layer — things nobody imports because they are
         * what imports. Listing them alongside real code that nothing calls
         * would bury the finding in noise, and a test that reports 38 files would
         * be a test people learn to skim.
         */
        const isEntryPoint = (file: string): boolean =>
            file.endsWith('.cli.ts') ||
            file === 'server.ts' ||
            file.startsWith('research/');

        const importedByProduction = new Set<string>();

        for (const edge of graph.edges) {
            if (!isTest(edge.from)) {
                importedByProduction.add(edge.to);
            }
        }

        const stranded = sources
            .filter((file) => !isTest(file))
            .map(relative)
            .filter((file) => !importedByProduction.has(file))
            .filter((file) => !isEntryPoint(file))
            .sort();

        // Sorted, because the code sorts, and an assertion that lists its
        // expected value in a more meaningful order than the thing under test
        // fails on every run for a reason that has nothing to do with the
        // finding. The commentary on what each entry means is below.
        expect(stranded).toEqual([
            'backtest/optimizer.ts',
            'db/retention.store.ts',
            'history/backfill.service.ts',
            'instruments/classify.ts',
            'observability/health.registry.ts',
            'signals/explanation.ts',
            'strategy/rule-registry.ts',
        ]);

        // **The registry is in the database now, and the configuration stayed on
        // top of it.** `instruments/asset.repository.ts` left this list when the
        // server started seeding `asset` and `instrument` at boot — the module
        // already had 22 tests behind it, including that it does not reactivate
        // a suspended asset and does not overwrite a classification learned
        // from data. It was never unfinished. It was unwired, which is a
        // different defect and one that looks exactly like finished work.
        //
        // What is left, and it is worth reading rather than skimming:
        //
        // `instruments/classify.ts` is PHASE 14 — the data-learned asset
        // classifier — and it is the last piece of the chain this project has
        // written without connecting. It is also the only consumer that would
        // make the `source = 'learned'` column mean anything, and the only
        // thing that could write a `category` the configuration never claimed.
        //
        // `backtest/optimizer.ts` is the second reader of global config that M4
        // could not account for, and the reason is simply that it is not called.
        //
        // **The second promotion ladder.** `rule-registry.ts` holds 312 lines
        // and disagrees with the ladder in use about whether a rule may be
        // retired from any stage, whether retirement is permanent, and whether
        // `rejected` is a state at all. `promotion.config.ts` is not in this
        // list because the stranded registry imports it — unreachable by
        // transitivity, which an importer check cannot see and which is why the
        // list needs a reader rather than only a test.
    });

    it('still finds the promotion subsystem when the graph says every layer is fine', () => {
        // The reason this file exists as a separate check. The layer report
        // answers "can this layer reach that one" and is entitled to say yes
        // here; this answers "does anything in this layer import this file",
        // which is a different question with a different answer.
        const graph = buildGraph(realRoot);

        const productionImporters = graph.edges.filter(
            (edge) =>
                !edge.from.includes('.test.') && edge.to.includes('strategy/rule-registry'),
        );

        expect(productionImporters).toEqual([]);
    });
});
