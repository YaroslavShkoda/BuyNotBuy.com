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
            'history/backfill.service.ts',
            'strategy/rule-registry.ts',
        ]);

        // **Everything the roadmap asked for in M1 is now connected.**
        //
        // `instruments/asset.repository.ts` left this list when the server began
        // seeding `asset` and `instrument` at boot — the registry moves into the
        // database and the configuration stays on top of it. The module already
        // had 22 tests behind it, including that seeding does not reactivate a
        // suspended asset and does not overwrite a classification learned from
        // data. It was never unfinished. It was unwired, which looks exactly
        // like finished work from the outside.
        //
        // `instruments/classify.ts` left next, and with it PHASE 14 stops being
        // a milestone and becomes a feature: `source = 'learned'` now has a
        // writer, and the column stops being a claim about the future.
        //
        // What remains is smaller, and none of it is on the critical path:
        // `backtest/optimizer.ts` is the second reader of global config that M4
        // could not account for, and the reason is simply that it is not called.
        //
        // **The second promotion ladder is not a duplicate, and this list is why
        // I nearly deleted the only implementation of the evidence gate.**
        //
        // `rule-registry.ts` holds 312 lines and no production caller, and it
        // keeps a different vocabulary from the ladder in use — eight values to
        // seven, with `rejected` among them. That reads as an unfinished
        // duplicate, and deleting it was the plan.
        //
        // Its tests are not about the words. They check that a shadow window is
        // long enough to collect what it demands, that a margin cannot promote
        // the incumbent into itself, and that a refusal says what is missing
        // rather than calling the rule bad. `advance()` calls `evaluateShadow`
        // when a rule moves to approval.
        //
        // `canTransition` in the ladder that is actually in use is
        // `NEXT_STAGE[from].includes(to)` — the order of the names — and
        // `promote()` checked that its `evidence` string was not empty and
        // nothing else. So the gate on self-promotion was a vocabulary, and the
        // only code that gated it on evidence was sitting in this list, unused.
        //
        // **`db/retention.store.ts` left this list, and wiring it up found a
        // policy that had never been run.** The retention policies were declared
        // in code, read by the health registry, and applied by nobody: the system
        // declared a three-year window for its history and kept everything
        // forever. The first real prune answered `42703` — the
        // `signal_transition` policy named a time column called `at`, and the
        // table has `candle_timestamp` and `created_at`. Nothing could have
        // caught it while the policy was never executed; it is now
        // `candle_timestamp`, which is also the right answer for a separate
        // reason, and every policy's column is checked against the real schema
        // by a test.
        //
        // `market_candles` and `signal_outcome` are refused outright, which the
        // live run confirmed along with the counts on both sides of the prune.

        // `rule-registry.ts` is still in the list, and **I nearly took it out for
        // the wrong reason.** What round 23 changed was the finding behind it,
        // not the module: the gate it implements now runs, through
        // `strategy/evidence.repository.ts` and `services/promotion-gate.ts`,
        // attached to the shared repository so that every entry point —
        // including both research CLIs — reaches it. The second ladder still has
        // no caller, which is a different question, written up in
        // docs/roadmap-v2-status.md.
        //
        // **`observability/health.registry.ts` left this list too, and it took a
        // lie with it.** It answered `ageMs: () => 0` and `stale: false`, so
        // `market-freshness` reported «снимок получен напрямую» at every instant
        // of the process's life, including every instant it served week-old
        // candles — and it did so without a database call, which is the
        // cheapest possible way to be confidently wrong. The poller now tells it
        // the age of the newest bar, and `/readyz` reports the registry's
        // components alongside its own checks without letting a stale daily bar
        // fail readiness: a weekend is not an outage.
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
