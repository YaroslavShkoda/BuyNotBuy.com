import { describe, expect, it } from 'vitest';

import { EXECUTION_CONFIG, EXECUTION_MODELS, ExecutionConfigParser } from './execution.js';

import type { ExecutionModel } from './execution.js';

/**
 * The three execution models, written down twice.
 *
 * `z.enum(['next_open', 'next_close', 'intrabar')` inside the schema, and
 * `EXECUTION_MODELS = [...]` below it — and `ExecutionModel` derived from the
 * *schema*, so the tuple nobody derived anything from was also the only list a
 * reader would consult to find out which models exist.
 *
 * That made the failure silent in the direction that matters. Adding a fourth
 * model to `EXECUTION_MODELS` compiled without error, changed no exported type,
 * and was then refused by the configuration. The one place a person would look
 * to discover the vocabulary was the one place that could disagree with it, and
 * nothing said so.
 *
 * Of the two duplicates recorded in round 51 this was the one flagged as
 * possibly having a substantive reason to stay in both places. It does not: the
 * validator accepts exactly these three and nothing more, which is a statement
 * about the set, not about the source of the set.
 */
describe('the execution models', () => {
    it('is one list, used by the validator', async () => {
        // **Asserted against the source, because no value assertion can do
        // this job.** The first version compared the schema's options with the
        // tuple and stayed green after `z.enum(['next_open', 'next_close',
        // 'intrabar'])` was put back by hand — the two copies hold the same
        // strings, so they compare equal and the duplication is invisible to
        // anything that runs. A retyped literal is only ever wrong relative to
        // its twin, and a twin's difference is a source-level fact.
        //
        // Reading the file is the third time this session that the guard had to
        // be a source-reading one. It is not a fallback: when a list has a
        // twin, no behavioural test can hold the line.
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');

        // **The sibling module, not this file.** The first version read
        // `import.meta.url`, which is the test — and the test spells all three
        // models in its own assertions and its own prose. So it counted three
        // occurrences, demanded one, and did that whether or not `execution.ts`
        // was duplicated at all. A guard that cannot tell the two states apart
        // is worse than none, because it looks like one that works.
        const source = readFileSync(
            fileURLToPath(new URL('./execution.ts', import.meta.url)),
            'utf8',
        );

        // **Counted as an enumeration, not as a spelling.** The second version
        // counted occurrences of each model string and demanded one, and found
        // three — `next_open` also appears as the environment default and in a
        // comparison, both of which are correct. A string can legitimately be
        // mentioned many times; a *declaration* cannot exist twice. So what is
        // counted is the three names written together, which is what a second
        // declaration would look like and what nothing else in the file is.
        const declaration = EXECUTION_MODELS.map((model) => `'${model}'`).join(', ');

        expect(source.split(declaration).length - 1).toBe(1);

        // And the schema still agrees with the list at runtime, because the
        // source check proves there is only one place to spell them and this
        // proves that place is the one being used.
        expect(ExecutionConfigParser.shape.model.options).toEqual([
            ...EXECUTION_MODELS,
        ]);
    });

    it('accepts every model it declares and refuses one that is not one', () => {
        for (const model of EXECUTION_MODELS) {
            const parsed = ExecutionConfigParser.parse({ ...EXECUTION_CONFIG, model });

            expect(parsed.model).toBe(model);
        }

        // The failure the duplication invited: a model in the list that the
        // configuration would not take.
        expect(() =>
            ExecutionConfigParser.parse({ ...EXECUTION_CONFIG, model: 'stop_limit' }),
        ).toThrow();
    });

    it('gives a caller the type the configuration accepts', () => {
        // The two directions of the same fact. The first version of this test
        // only checked one, which is why the defect survived: the tuple and the
        // schema could disagree while every consumer still typechecked.
        const model: ExecutionModel = EXECUTION_MODELS[0];

        expect(EXECUTION_MODELS).toContain(model);
        expect(EXECUTION_CONFIG.model).toBe(EXECUTION_CONFIG.model satisfies ExecutionModel);
    });

    it('is exactly the three the comment argues for', () => {
        // The list is short on purpose, and the reasoning is above it: a
        // backtest offering only the flattering two offers the third silently.
        expect([...EXECUTION_MODELS].sort()).toEqual([
            'intrabar',
            'next_close',
            'next_open',
        ]);
    });
});