import { describe, expect, it } from 'vitest';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The direction vocabulary, written out more than once.
 *
 * A type alias is not a runtime value, so nothing in the test suite can notice
 * that `'LONG' | 'SHORT' | 'NEUTRAL'` has been typed out a fourth time: both
 * copies behave identically for every input, and the failure only appears when
 * somebody adds a fourth direction to one of them and not the other. The
 * compiler will not catch that, because each copy is a perfectly good type.
 *
 * That is the whole reason this file exists, and the reason it reads the source
 * rather than calling the module. A test asserting that `SignalDirection`
 * equals `SignalDirection` proves nothing at all.
 *
 * What is checked is the count of *declarations* in production source, so the
 * answer to "is this written out again?" is measured rather than remembered.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES_DIR = 'types';

/**
 * The forms the vocabulary may take in production source.
 *
 * **Two, not one, and the second exists because a type has no value.** Until
 * round 47 this file forbade a single spelling — the union — which was right
 * about the property and wrong about the forms: `api/schemas.ts` needs a
 * `z.enum`, a union is erased at compile time, and that module had gone on
 * retyping the three literals rather than live without the word. Fixing that by
 * changing the declaration to a tuple then broke this test, which is what a test
 * pinned to a spelling does: it fails when the code is fixed.
 *
 * What matters is that the vocabulary is written down once, not in which shape.
 * Both spellings below declare it; a file that contains either is a declaration.
 */
const DECLARATIONS = [
    "'LONG' | 'SHORT' | 'NEUTRAL'",
    "['LONG', 'SHORT', 'NEUTRAL']",
];

/** Whether a file spells the vocabulary out, in any accepted form. */
const declares = (source: string): boolean =>
    DECLARATIONS.some((form) => source.includes(form));

/**
 * Files whose content is not production code.
 *
 * Tests assert on literals on purpose — a test that writes `'LONG'` to build a
 * fixture is not duplicating a declaration, and this file is the proof, since
 * it names the form in order to forbid it. Migrations carry the list inside SQL
 * strings, which cannot import a TypeScript type and should not be made to.
 */
const NOT_SOURCE = (relativePath: string): boolean =>
    relativePath.startsWith('migrations') || relativePath.startsWith('research/');

function sources(directory: string): string[] {
    const found: string[] = [];

    for (const entry of readdirSync(directory)) {
        if (entry === 'node_modules' || entry === 'test-support') {
            continue;
        }

        const absolute = join(directory, entry);

        if (statSync(absolute).isDirectory()) {
            found.push(...sources(absolute));

            continue;
        }

        // Tests are skipped here rather than filtered later, because this file
        // is itself under `types/` and names the form it is forbidding. An
        // earlier version filtered test files in the assertion and failed for
        // exactly that reason: it was the fourth place the vocabulary appeared.
        if (
            absolute.endsWith('.ts') &&
            !absolute.endsWith('.d.ts') &&
            !absolute.endsWith('.test.ts')
        ) {
            found.push(absolute);
        }
    }

    return found;
}

describe('the direction vocabulary has exactly one declaration', () => {
    it('is declared once, in a layer every other layer may import', () => {
        // The reason for the file's location. `types` is in the layer table's
        // UNIVERSAL set, so `strategies`, `indicators` and `signals` can all
        // name the direction without any of them reaching into another. The
        // violation this replaced was `strategies/types.ts → signals/`, and it
        // existed only because `signals/` had claimed a word that all of them
        // use.
        const declaring = sources(join(root, TYPES_DIR))
            .filter((file) => declares(readFileSync(file, 'utf8')))
            .map((file) => relative(root, file).split(sep).join('/'))
            .sort();

        expect(declaring).toEqual(['types/direction.ts']);
    });

    it('is not written out anywhere else in production source', () => {
        // The property that actually needs holding. Adding a direction to one
        // copy and not the others compiles cleanly, passes every behavioural
        // test, and produces a type that accepts a value the database has
        // never heard of.
        const elsewhere = sources(root)
            .map((file) => relative(root, file).split(sep).join('/'))
            .filter((path) => !path.startsWith('test-support'))
            .filter((path) => !NOT_SOURCE(path))
            .filter((path) => path !== 'types/direction.ts')
            .filter((path) =>
                declares(readFileSync(join(root, path), 'utf8')),
            )
            .sort();

        expect(elsewhere).toEqual([]);
    });

    it('keeps the old name working, so the cleanup is not a migration', () => {
        // `IndicatorSignal` is still what most of the codebase imports. It is
        // now an alias rather than a second declaration, and this is the
        // assertion that says so: the two names are the same type, so a caller
        // can pass one where the other is expected in both directions. If a
        // future edit gives them different members, this stops compiling.
        const signals = readFileSync(
            join(root, 'signals', 'signal.types.ts'),
            'utf8',
        );

        expect(signals).toContain('export type IndicatorSignal = SignalDirection;');
        expect(declares(signals)).toBe(false);
    });
});
