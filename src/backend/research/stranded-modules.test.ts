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
 * turned out to be invisible from this side. `lifecycle/rule-registry.ts` and
 * `lifecycle/promotion.config.ts` together once held 572 lines of rule
 * lifecycle — `createRule`, `productionRules`, `activeRule`, `auditProduction`,
 * `advance`, `planRollback` and the whole `RuleStage` ladder — and the only file
 * in the repository that imported either was its own test, 545 lines long.
 *
 * **The list is empty now, and that took two rounds rather than one.**
 * `promotion.config.ts` left it when the evidence gate was wired to the shared
 * repository in round 23, so that half of the finding was a bug that has been
 * fixed. `rule-registry.ts` stayed for the owner to rule on, and what it was
 * holding — a second ladder the schema cannot store — was deleted rather than
 * adopted. Deleting it was only safe after the gate above was proven to run
 * elsewhere; see the note on `expect(stranded)` below for why that order was not
 * a detail.
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
        //
        // **Empty, and this is the first time it has been.** The last entry was
        // `lifecycle/rule-registry.ts` — 312 lines, no production caller — and
        // the owner decided to delete it rather than adopt its vocabulary, which
        // settles the argument recorded below in the only direction that leaves
        // one ladder instead of two.
        //
        // **Before deleting it I checked what the list would lose**, because every
        // other module on this list turned out to contain something the system
        // needed and the note in this file says so one by one. The concern was
        // specific: round 23 found that the only code anywhere gating promotion
        // on evidence sat in the stranded module, while the ladder in use checks
        // nothing but a non-empty string. That is no longer true, and it is worth
        // naming why:
        //
        // - The gate that runs is `services/promotion-gate.ts`, attached in
        //   `server.ts` to the shared repository, so every entry point — including
        //   both research CLIs — reaches it.
        // - It calls `evaluateShadow` out of `lifecycle/promotion.config.ts`, the
        //   module that declares the evidence conditions.
        // - A promotion cannot even be constructed without a `strategyVersionId`,
        //   and the gate refuses approval without one.
        //
        // So the deleted module was a second implementation of a gate that
        // already runs, not the last one. `createRule`, `auditProduction`,
        // `advance` and `planRollback` went with it: conflict-audit and rollback
        // planning have no counterpart in the codebase, which means they were
        // capabilities nobody had asked for rather than features with a bug in
        // them. That is the honest reading, and it is the opposite of what I would
        // have written if I had deleted first and measured after.
        expect(stranded).toEqual([]);

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
        // `rule-registry.ts` was the last entry and is deleted. What it was is
        // worth keeping, because the reason is a trap this list has now sprung
        // twice on the same file.
        //
        // **The second promotion ladder was not a duplicate, and this list is why
        // I nearly deleted the only implementation of the evidence gate.**
        //
        // It held 312 lines and no production caller, and it kept a different
        // vocabulary from the ladder in use — eight values to seven, with
        // `rejected` among them. That reads as an unfinished duplicate, and
        // deleting it was the plan.
        //
        // Its tests were not about the words. They checked that a shadow window
        // is long enough to collect what it demands, that a margin cannot promote
        // the incumbent into itself, and that a refusal says what is missing
        // rather than calling the rule bad. `advance()` called `evaluateShadow`
        // when a rule moved to approval.
        //
        // `canTransition` in the ladder that is actually in use is
        // `NEXT_STAGE[from].includes(to)` — the order of the names — and
        // `promote()` checked that its `evidence` string was not empty and
        // nothing else. So the gate on self-promotion was a vocabulary, and the
        // only code that gated it on evidence was sitting in this list, unused.
        //
        // Round 23 wired the gate properly — `services/promotion-gate.ts` plus
        // `lifecycle/evidence.repository.ts`, attached to the shared repository so
        // that every entry point reaches it — and that is what made deleting the
        // ladder safe rather than merely tidy. **Wiring it up first is the part
        // that was not optional**, and the reason is worth stating plainly: if the
        // owner had decided to delete this module while it was the only
        // implementation of the gate, the deletion would have looked correct from
        // every measurement available and would have removed the only code that
        // asked whether a rule deserved approval.
        //
        // The disagreement the vocabulary encodes is not gone; it moved to
        // `lifecycle/promotion.config.ts`, which is connected and still declares
        // stages migration 17's CHECK cannot hold. `stage-vocabulary.test.ts`
        // still enumerates them one by one, which is where the open question
        // lives now: `retired → candidate` is allowed there and `retired` is
        // terminal in storage. Deleting the duplicate chose the stored policy and
        // did not answer what a retired rule means.
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

        // **`backtest/optimizer.ts` left this list, and running it found two
        // things reading the code would not have.**
        //
        // The caller is `optimize.cli.ts`, a command line. A grid search that
        // promoted its own winner would skip the seven rungs between a number
        // and a rule; the ladder is Signal → Outcome → Statistics → Candidate →
        // Backtest → Walk-forward → Shadow → Approval → Production, and the
        // search's output still has to be read by a person before any of it
        // happens.
        //
        // First: `startIndex` is where a signal may be *computed*, not where the
        // series starts. My first version passed `0` and the search died on
        // `MARKET_INSUFFICIENT_HISTORY` — a message about EMA warm-up, correct,
        // and about the wrong bar.
        //
        // Second, and the one worth more: a real search produced a winner of
        // −0.12% per trade that **passed the spike check**. Its neighbours are
        // just as losing, so the peak test had nothing to object to. "Not a
        // spike" means the number is not an artefact; it says nothing about the
        // number being positive, and the report was ending on a reassuring line
        // after a passing check. It now says which of the two it found.

        // **`history/backfill.service.ts` left this list, and wiring it up found
        // the one write in this system that can change stored history.**
        //
        // `bulkUpsert` issues `ON CONFLICT ... DO UPDATE` and returns a single
        // number, so filling a gap and replacing a bar that was already stored
        // are the same event from the write's side. They are not the same thing:
        // the second moves the inputs under every signal, outcome and backtest
        // already computed from those bars, and nothing downstream would show
        // it. The progress object now counts the two separately, and the report
        // warns when the second is non-zero.
        //
        // The caller is a command, not a scheduler. The ingestion scheduler
        // already keeps the table filled going forward; walking backwards
        // through time is an operator's decision about whose corrections to
        // accept over bars everything else is measured against.

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

    it('sees the importers of a file that has them, so the empty answer above is a fact', () => {
        // The reason this file exists as a separate check. The layer report
        // answers "can this layer reach that one" and is entitled to say yes
        // here; this answers "does anything in this layer import this file",
        // which is a different question with a different answer.
        //
        // **The probe moved.** This test used to point at
        // `lifecycle/rule-registry.ts` and assert it had no production importer,
        // which was true and was the whole finding. Now that the module is gone,
        // the same assertion would be about a path no file occupies — it would
        // pass forever and mean nothing, which is worse than not having it.
        //
        // So it asks the other direction. An empty answer is only worth reading
        // if the same mechanism can produce a non-empty one, and asserting that
        // on a real file is what keeps the previous assertion from being
        // vacuous.
        const graph = buildGraph(realRoot);

        const importersOfTheLadder = graph.edges.filter(
            (edge) =>
                !edge.from.includes('.test.') &&
                edge.to.includes('strategies/candidate.repository'),
        );

        // `server.ts` builds the shared repository and both research CLIs read it,
        // so this is not a count anyone has to maintain: it is a claim that the
        // filter above can see edges at all.
        expect(importersOfTheLadder.length).toBeGreaterThan(0);
    });

    /**
     * Half a minute, and the default five seconds is not a statement about
     * anything.
     *
     * Both tests here walk every production module and resolve its import
     * graph. That is 199 files at the time of writing, and the cost is linear
     * in the codebase: adding four production files — two commands and two
     * reports — was enough to push this past the default budget in the full
     * parallel run, while the same file passed alone. It is the same failure
     * `contract-semantics` had, and the remedy is different on purpose: there
     * the boot was repeated sixteen times and could be shared, and here the scan
     * *is* the work — one whole-tree pass, nothing to share.
     *
     * Raising a limit is a change I distrust by default, so it is worth saying
     * what makes this one different: the limit was never about this test. It was
     * a default applied to something whose duration tracks the size of the
     * repository, and the assertion it guards — that nothing production is
     * stranded — is worth a few seconds of honest work.
     */
}, 30_000);
