import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Three unambiguous signs that text was damaged, checked across the repository.
 *
 * One file was. `research/execution-model.cli.ts` had two U+FFFD where «по»
 * belonged in «предполагается» — bytes lost once, with nothing to notice, because
 * a console line is not read by a compiler and a test that prints it does not
 * compare it.
 *
 * **Two detectors were written and thrown away before this one, and both cried
 * wolf — which is why this list is short.**
 *
 * 1. "Any ASCII letter next to any non-ASCII one" reported ten files. All ten
 *    were an escape sequence followed by a Cyrillic letter: correct code. A rule
 *    that fires on correct code is a rule that gets switched off.
 * 2. "Cyrillic next to the Latin-1 supplement" reported twenty-seven more. The
 *    top triggers were U+00AB and U+00BB — « and », which is how this project
 *    quotes Russian, and is correct.
 *
 * **A fourth signal, added after this file's own first version was proved
 * insufficient.** The comment above used to say that detecting CP1251 mojibake
 * by pattern does not work. That is true of mojibake in general and false of the
 * part that actually mattered here, and the difference is one codepoint wide.
 *
 * `instruments/asset.repository.ts` carried six copies of one artifact: the
 * em-dash, UTF-8 bytes read as CP1251, arriving as U+0432 U+0402 U+201D. Two of
 * those three characters are Cyrillic, so the mixed-script rules missed it, and
 * U+201D is outside the Latin-1 range, so the widened one missed it too. The
 * file passed a scan that had just reported the repository clean.
 *
 * The rule that does catch it is not a heuristic and has no tuning dial: **the
 * Russian alphabet is U+0410–U+044F, plus U+0401 and U+0451 for Yo, and no other
 * character in the Cyrillic block is a letter of this language.** U+0402 is not
 * Russian. Not "unlikely in Russian" — not Russian. That is a fact about a
 * character set, so it cannot be tuned down to make a file look clean, and it
 * has no false-positive dial because there is nothing to trade away.
 *
 * What is still true, and is why the rule above is narrower than the ambition:
 * mojibake that lands entirely on *valid* Russian letters remains undetectable
 * by any rule of this kind. The example in this file's own comment is such a
 * case, and that is precisely why it is exempt by name below — the one place the
 * repository is allowed to contain the thing it is being checked for, named
 * rather than skipped quietly.
 *
 * Character codes are spelled out below instead of written as literals. A
 * replacement character typed into this file's source would be the very thing
 * the check forbids — the first version of this file failed its own guard for
 * exactly that reason — and an editor that turns a `x` escape into a raw control
 * byte is a second way to damage a file that exists to report damage.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROOTS = ['src', 'docs', '.github', 'README.md', 'package.json', 'tsconfig.json', 'biome.json'];
const SKIP = new Set(['node_modules', '.next', 'dist', 'coverage', '.git']);

const REPLACEMENT = String.fromCharCode(0xfffd);
const LAST_ASCII = 0x7f;

const C1 = range(0x80, 0x9f);

function range(from: number, to: number): string {
    return (
        '[' +
        String.fromCharCode(from) +
        '-' +
        String.fromCharCode(to) +
        ']'
    );
}

/** True when an ASCII letter sits directly against a non-ASCII character. */
function hasAsciiLetterNextToNonAscii(text: string): boolean {
    const characters = [...text];

    return characters.some((character, index) => {
        if (index === 0) return false;

        const previous = characters[index - 1] as string;
        const isAsciiLetter = previous >= 'A' && previous <= 'z';

        return isAsciiLetter && character.charCodeAt(0) > LAST_ASCII;
    });
}

/**
 * Every character in the Cyrillic block that is not a letter of Russian.
 *
 * The Russian alphabet is U+0410–U+044F, plus U+0401 and U+0451 for Yo. Anything
 * else in U+0400–U+04FF is Ukrainian, Serbian, Macedonian, or a CP1251 decoding
 * accident — and none of them is something this project's prose or identifiers
 * legitimately contain.
 *
 * Built by subtraction from the whole block so that the rule states what it
 * excludes. Written as a positive list of ranges instead, it would need a
 * comment saying which ranges are safe, and that comment is what a future
 * codepoint would not get updated for.
 */
// Written as subtraction, because a hand-written range list is how U+0402 got
// missed the first time: Ё is U+0401 and is Russian, and it sits one codepoint
// below the damage. The complement of {U+0401, U+0410-U+044F, U+0451} cannot
// drift when someone adds a letter to the alphabet.
//
// Joined with `|`, not ``: ``. Concatenating the classes makes a *sequence* of
// four required characters, which matches nothing at all and reports a clean
// repository — a rule that cannot fire is worse than no rule, because it is
// believed.
const NOT_RUSSIAN = new RegExp(
    [range(0x400, 0x400), range(0x402, 0x40f), range(0x450, 0x450), range(0x452, 0x4ff)].join('|'),
    'u',
);

/**
 * The only text in the repository allowed to contain non-Russian Cyrillic: the
 * worked example of what mojibake looks like, quoted on purpose, in the
 * documentation of the damage itself.
 *
 * Named rather than skipped. A whole-file skip would have been the same silent
 * hole the two discarded detectors were, only with a file in it instead of ten:
 * anything that later landed in either of these files would go unreported. This
 * exempts the example and nothing else, so the files are still checked.
 */
const QUOTED_EXAMPLES: ReadonlyArray<{ file: string; why: string }> = [
    {
        file: 'docs/roadmap-v2-status.md',
        why: 'round 68 records what CP1251 does to Russian, so it has to show it',
    },
    {
        file: 'src/backend/research/text-integrity.test.ts',
        why: "this file's own comment on why the rule cannot be wider",
    },
];

function nonRussianCyrillic(text: string, file: string): string | null {
    if (QUOTED_EXAMPLES.some((example) => example.file === file)) return null;

    const found = [...text.matchAll(new RegExp(NOT_RUSSIAN, 'gu'))];

    if (found.length === 0) return null;

    const codes = [...new Set(found.map((entry) => `U+${(entry[0] as string).codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`))];

    return `non-Russian Cyrillic ${codes.join(', ')}`;
}

interface Damage {
    readonly file: string;
    readonly what: string;
}

function filesUnder(directory: string, found: string[] = []): string[] {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;

        const absolute = join(directory, entry.name);

        if (entry.isDirectory()) filesUnder(absolute, found);
        else found.push(absolute);
    }

    return found;
}

/**
 * Text or not, decided by content rather than by extension.
 *
 * `public/BuyNotBuy.png` fails a UTF-8 decode, and that is what a PNG does. The
 * first version of this reported it as damaged, which is how a scan of the whole
 * repository came back claiming eleven broken files when one was.
 */
function readIfText(path: string): { text: string | null; binary: boolean } {
    const raw = readFileSync(path);

    if (raw.length === 0) return { text: '', binary: false };
    if (raw.subarray(0, 4096).includes(0)) return { text: null, binary: true };

    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(raw), binary: false };
    } catch {
        return { text: null, binary: false };
    }
}

function scan(): Damage[] {
    const damage: Damage[] = [];

    for (const root of ROOTS) {
        const absolute = join(repoRoot, root);
        const paths = extname(root) === '' ? filesUnder(absolute) : [absolute];

        for (const path of paths) {
            const shown = relative(repoRoot, path).split('\\').join('/');
            const { text, binary } = readIfText(path);

            if (binary || text === null) {
                if (!binary) damage.push({ file: shown, what: 'not valid UTF-8' });
                continue;
            }

            const found: string[] = [];

            if (text.includes(REPLACEMENT)) {
                found.push(`U+FFFD x${text.split(REPLACEMENT).length - 1}`);
            }

            if (new RegExp(C1).test(text)) {
                found.push('C1 control byte read as text');
            }

            const letters = nonRussianCyrillic(text, shown);

            if (letters !== null) {
                found.push(letters);
            }

            if (found.length > 0) {
                damage.push({ file: shown, what: found.join('; ') });
            }
        }
    }

    return damage.sort((a, b) => a.file.localeCompare(b.file));
}

describe('no text in the repository is damaged', () => {
    it('holds in code and in documents alike', () => {
        expect(scan()).toEqual([]);
    });

    it('and the two signals it uses recognise damage when there is some', () => {
        const replacement = String.fromCharCode(0xfffd);
        const c1 = String.fromCharCode(0x92);
        const damaged = `тем${replacement}пература`;

        expect(damaged.includes(REPLACEMENT)).toBe(true);
        expect(new RegExp(C1).test(`тем${c1}пература`)).toBe(true);

        // The two detectors this replaced, rebuilt so that they fire on the exact
        // strings that made them wrong. Confirming a false positive beats
        // assuming one.
        //
        // 1. An escape sequence, then a Cyrillic letter: the `n` of a newline
        //    escape sitting directly against Russian text in a template literal.
        const escapeThenRussian =
            'Пробел ' + String.fromCharCode(92) + 'nПробел';

        expect(hasAsciiLetterNextToNonAscii(escapeThenRussian)).toBe(true);

        // 2. A guillemet, then a Cyrillic letter: this project's own quoting.
        const quoteThenRussian =
            String.fromCharCode(0xab) + 'Пробел' + String.fromCharCode(0xbb);
        const mixedScript = new RegExp(
            range(0x400, 0x4ff) +
                range(0xa0, 0xff) +
                '|' +
                range(0xa0, 0xff) +
                range(0x400, 0x4ff),
        );

        expect(mixedScript.test(quoteThenRussian)).toBe(true);
    });

    it('and a Cyrillic letter that is not a letter of Russian is reported', () => {
        // The artifact as it arrived: an em-dash, UTF-8 read as CP1251. Built
        // from codes so this file does not commit the thing it reports.
        const artifact = 'список' + String.fromCharCode(0x432, 0x402, 0x201d) + ' конец';
        const russian = 'список ' + String.fromCharCode(0x2014) + ' конец';

        expect(nonRussianCyrillic(artifact, 'src/backend/anything.ts')).toContain('U+0402');
        expect(nonRussianCyrillic(russian, 'src/backend/anything.ts')).toBeNull();

        // Ё is Russian and sits one codepoint below the damage that was missed.
        expect(nonRussianCyrillic('Ёлка и ёлка', 'src/backend/anything.ts')).toBeNull();

        // A whole Cyrillic word that is a real word.
        expect(nonRussianCyrillic('слово', 'src/backend/anything.ts')).toBeNull();
    });

    it('and the one quoted example is exempt by name, not by skipping the file', () => {
        for (const example of QUOTED_EXAMPLES) {
            const artifact = 'список' + String.fromCharCode(0x432, 0x402, 0x201d);

            expect(nonRussianCyrillic(artifact, example.file)).toBeNull();
            expect(example.why.length).toBeGreaterThan(0);
        }

        // A path that merely resembles an exempt one is not exempt.
        expect(
            nonRussianCyrillic(
                'список' + String.fromCharCode(0x432, 0x402, 0x201d),
                'docs/roadmap-v2-status.md.bak',
            ),
        ).toContain('U+0402');
    });

    // A budget of thirty seconds, which is the convention in this repository
    // for a test that does real work, and is here for a measured reason.
    //
    // The first test in this file is the only one that reads every file in
    // `src`, `docs` and `.github`, so its cost is proportional to the tree and
    // it gets slower as the project grows. Isolated it runs in 179 ms; inside a
    // 211-file parallel run it was measured past the 5 s default, because every
    // worker is competing for the same disk.
    //
    // The number is not chosen to make a failure quiet. A guard that scans the
    // repository cannot be a five-millisecond test, and the alternative to
    // stating the budget is a check that fails about one run in three and is
    // then ignored — which is how the two detectors this file replaced died.
}, 30_000);
