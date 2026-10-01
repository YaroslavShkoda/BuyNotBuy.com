import { readFileSync, readdirSync } from 'node:fs';
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
 * **What is deliberately not here.** Detecting CP1251 mojibake of Russian by
 * pattern does not work, because UTF-8 bytes read as CP1251 mostly produce
 * *valid-looking Cyrillic*: «Привет» comes back as «РџРёРІРµС‚», every character
 * of it a real Cyrillic letter. No cheap rule separates that from Russian. A
 * check claiming to detect it would be a check that eventually reports the whole
 * documentation as broken.
 *
 * So these three remain, and each is a fact rather than a guess: a byte sequence
 * that is not UTF-8, a replacement character where a decoder gave up, and a C1
 * control byte that was read as text when it was not.
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
});