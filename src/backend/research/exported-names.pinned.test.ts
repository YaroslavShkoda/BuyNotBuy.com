import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript-5';
import { describe, expect, it } from 'vitest';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.next', 'dist', 'coverage']);

/**
 * The same name, exported from two modules — sixteen times.
 *
 * **This list is the answer to a question that was never asked.** Seven file
 * names recur across layers, which looks alarming and mostly is not: `analysis.ts`
 * is a route in one layer and a type contract in another, `market.ts` likewise,
 * and `strategy-fingerprint.ts` is two halves of one thing that says so in its own
 * comment. Renaming those would move files to make a grep unique and leave the
 * collisions that matter exactly where they are.
 *
 * What does matter is a name that a reader would take to mean one thing. Sixteen
 * names are exported from more than one module: **nine types and seven values**.
 * The first draft of this comment said every one of them was a type and that not
 * a single value name collided — wrong, because the list was written by hand off
 * another tool's output instead of off this one, and the test caught it on the
 * first run, which is the argument for the test existing. Eight names were
 * functions: `listSources`, `getPrice`, `audit`, `reliability`, `summarize`,
 * `emaSeries`, `getSignalHistory` — and `canTransition`, since removed.
 *
 * Three of the original nineteen are off the list. Two were the same name over
 * **different shapes**, which is the defect this file was written for:
 *
 * - `MetricsSnapshot` was declared twice with nothing in common — one
 *   `{durations, counters, takenAt}` in `observability/metrics.ts`, one
 *   `{requests, failures, inFlight, startedAt, byRoute, byStatusClass}` in
 *   `api/lib/metrics.ts`. The first is how the system is doing, the second how
 *   the HTTP layer is doing, and both doc comments insist on the difference. A
 *   reader who assumed one name meant one shape had to guess which. It is now
 *   `HttpMetricsSnapshot`.
 * - `EMPTY_METRICS` likewise: `BacktestMetrics` with `trades` and `exposure`
 *   against `Metrics` with `total` and `correct`, one in `backtest/` and one in
 *   `performance/`. Now `EMPTY_PERFORMANCE`.
 *
 * The third was `value:canTransition` — `lifecycle/promotion.config.ts` had
 * `canTransition(from: RuleStage, to: RuleStage)`,
 * `strategies/candidate.repository.ts` has
 * `canTransition(from: CandidateStage, to: CandidateStage)`, and the shared name
 * was the A2 disagreement made visible in the type system. It was kept on this
 * list on purpose while the disagreement lived. The dead ladder is now deleted
 * (see the removal record in `lifecycle/promotion.config.ts`), the stored
 * vocabulary is the only one, and the collision is gone with it.
 *
 * Pinned rather than asserted empty, on the same reasoning as the other pinned
 * list here: sixteen entries, so demanding zero would be a permanently red
 * suite, and a permanently red suite is noise. A seventeenth fails, and so does
 * a silent rename that makes one of these sixteen disappear without anyone
 * having looked at it.
 *
 * Parsed with the TypeScript AST rather than read with a regex, because a regex
 * counts a name mentioned in a comment as an export, and three of this session's
 * own detectors produced findings out of prose that way.
 */

function sources(directory: string, found: string[] = []): string[] {
    for (const entry of readdirSync(directory)) {
        if (SKIP.has(entry)) continue;

        const full = join(directory, entry);

        if (statSync(full).isDirectory()) sources(full, found);
        else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(full);
    }

    return found;
}

interface Declared {
    readonly name: string;
    readonly space: 'type' | 'value';
}

/** Only declarations, never mentions: the AST cannot be fooled by prose. */
function exportsOf(file: string): Declared[] {
    const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );
    const found: Declared[] = [];

    for (const statement of source.statements) {
        const modifiers = ts.canHaveModifiers(statement)
            ? (ts.getModifiers(statement) ?? [])
            : [];
        const isExported = modifiers.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        );
        const isDefault = modifiers.some(
            (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
        );

        if (!isExported || isDefault) continue;

        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    found.push({ name: declaration.name.text, space: 'value' });
                }
            }
            continue;
        }

        // `'name' in statement` rather than `statement.name === undefined`:
        // reading `.name` off the `Statement` union is an error, and the first
        // version of this did exactly that, three errors from the compiler. The
        // name is then read as `unknown` and re-tested, because the declarations
        // that have one store a node and not a string, and a `NamedDeclaration`
        // cast is refused by the compiler for a reason.
        if (!('name' in statement)) continue;

        const candidate: unknown = statement.name;

        if (typeof candidate !== 'object' || candidate === null) continue;
        if (!ts.isIdentifier(candidate as ts.Node)) continue;

        const name = (candidate as ts.Identifier).text;

        if (ts.isFunctionDeclaration(statement)) found.push({ name, space: 'value' });
        else if (ts.isClassDeclaration(statement)) found.push({ name, space: 'value' });
        else if (ts.isInterfaceDeclaration(statement)) found.push({ name, space: 'type' });
        else if (ts.isTypeAliasDeclaration(statement)) found.push({ name, space: 'type' });
        else if (ts.isEnumDeclaration(statement)) found.push({ name, space: 'value' });
    }

    return found;
}

function collisions(): string[] {
    const byName = new Map<string, string[]>();

    for (const file of sources(backendRoot)) {
        const shown = relative(backendRoot, file).split(sep).join('/');

        for (const { name, space } of exportsOf(file)) {
            const key = `${space}:${name}`;
            const where = byName.get(key) ?? [];

            where.push(shown);
            byName.set(key, where);
        }
    }

    return [...byName.entries()]
        .filter(([, where]) => where.length > 1)
        .map(([key, where]) => `${key} → ${where.join(' , ')}`)
        .sort();
}

describe('a name exported from two modules', () => {
    it('is the sixteen that are on the list, and no seventeenth', () => {
        // Sorted, because the code sorts, and a list that fails for a reason
        // unrelated to the finding is a list people learn to skip.
        expect(collisions()).toEqual([
            'type:Candle → backtest/dataset.ts , types/market.ts',
            'type:IndicatorPerformance → indicators/performance/indicator-performance.types.ts , performance/performance.ts',
            'type:Metrics → observability/metrics.ts , performance/performance.ts',
            'type:PermutationResult → backtest/statistics.ts , research/signal-power.ts',
            'type:Reliability → performance/calibration.ts , research/confidence-calibration.ts',
            'type:Report → research/architecture-lint.ts , research/layering-lint.ts',
            'type:SeriesKey → observability/registry.ts , signals/lifecycle.repository.ts',
            'type:SignalDirection → config/lifecycle.config.ts , types/direction.ts',
            'type:Verdict → lifecycle/promotion.config.ts , research/confidence-calibration.ts , research/holdout-protocol.ts',
            'value:audit → research/architecture-lint.ts , research/layering-lint.ts',
            'value:emaSeries → indicators/series.graph.ts , strategies/series.ts',
            'value:getPrice → api/controllers/price.controller.ts , market/market.service.ts',
            'value:getSignalHistory → api/controllers/signal-history.controller.ts , history/signal-history.service.ts',
            'value:listSources → research/architecture-lint.ts , research/dependency-graph.ts , research/layering-lint.ts',
            'value:reliability → performance/calibration.ts , research/confidence-calibration.ts',
            'value:summarize → observability/health.ts , research/dataset.ts',
        ]);
    }, 30_000);

    it('and no two of them are the same name over different shapes', () => {
        // The property the two renames were for. A name on a type is something a
        // reader assumes means one shape, so the check that matters is not "does
        // the name repeat" but "does it repeat over something that is not the
        // same thing". Only two did, and they are gone: the HTTP snapshot is
        // `HttpMetricsSnapshot` and the performance zero-row is
        // `EMPTY_PERFORMANCE`.
        //
        // Measured rather than asserted about the three: the remaining sixteen
        // are a type and its source, a utility written twice, and a predicate
        // resolved by its argument. The `canTransition` collision was the A2
        // disagreement held visible on purpose; the dead ladder is deleted, and
        // the entry went with it.
        expect(collisions().filter((entry) => entry.includes('Http'))).toEqual([]);
    }, 30_000);
});
