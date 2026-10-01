import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGraph, listSources, violations } from './dependency-graph.js';

const realRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * The declared layer edges, against the tree, rather than the rule alone.
 *
 * `dependency-graph.test.ts` proves the *rule*: that `permits('indicators',
 * 'db')` is false and `permits('history', 'db')` is true. That is the right thing
 * for it to do, and it means the rule is sound while nothing whatsoever says
 * whether the codebase obeys it.
 *
 * So the check that does say — the one that prints "these require a decision,
 * not silence" and exits 1 — runs only when somebody types its name. It is in
 * neither `package.json` nor `.github/workflows/ci.yml`. A violation found by
 * hand is a violation with no addressee, which is the same defect as an
 * `logger?.warn` on a call that passes no logger: the report was written, it was
 * accurate, and nobody could receive it.
 *
 * **Pinned rather than asserted empty, on purpose.** There are three today, so a
 * test demanding zero would be a permanently red suite, and a permanently red
 * suite is read as noise within a week — the same death as the noisy detectors
 * in round 68. A pinned list is the shape `stranded-modules.test.ts` uses for
 * the one module nothing reaches, and it has the property that matters: it fails
 * when the situation *changes*, and only then. A fourth edge fails this test; so
 * does removing one of these, which is the signal to delete the pin deliberately
 * rather than to leave two lists to drift apart.
 *
 * All three are `import type`, so `verbatimModuleSyntax` erases them and there is
 * no runtime dependency in any of the three. They are still real coupling at the
 * type level: `types/analysis.ts` cannot be read without the indicator and signal
 * modules' declarations, and the declaration says `types` reaches nothing. The
 * declaration is the authority by the project's own rule, so the code is what is
 * out of line — and moving three wire types across three layers is not a change to
 * make without the owner, which is what the tool has been asking for.
 */
describe('declared layer edges, measured against this codebase', () => {
    it('has the three undeclared edges it had, and no fourth', () => {
        const graph = buildGraph(realRoot);

        const found = violations(graph)
            .map((edge) => `${edge.from}:${edge.line} → ${edge.to}`)
            .sort();

        expect(found).toEqual([
            'types/analysis.ts:1 → indicators/indicator.service.ts',
            'types/analysis.ts:2 → signals/signal.types.ts',
            'types/analysis.ts:3 → indicators/divergence.service.ts',
        ]);
    });

    it('and they are the type-only kind, so the report should say so', () => {
        const graph = buildGraph(realRoot);
        const files = new Set(violations(graph).map((edge) => edge.from));

        // If any of them ever stops being a type import it stops being erased,
        // and the shape of the problem changes from coupling to a runtime
        // dependency. The pin above would still pass — same three paths — so this
        // is the assertion that notices.
        expect([...files]).toEqual(['types/analysis.ts']);
    });

    it('and every source file is still in some layer', () => {
        // A file that belongs to no declared layer is reported as
        // `unplaced-layer` by the same tool, and the pin above only covers
        // `violations`. A module that quietly leaves the layering is the one
        // failure mode the whole table exists to prevent, so it gets its own
        // line rather than a footnote.
        const graph = buildGraph(realRoot);
        const placed = new Set(listSources(realRoot).map((file) => file.slice(realRoot.length).replace(/^[\\/]/, '').split('\\').join('/')));

        expect(graph.edges.every((edge) => placed.has(edge.to) || edge.internal)).toBe(true);
    });
});
