/**
 * PHASE 46, built before PHASE 1, on purpose.
 *
 * Every other phase in this roadmap adds a rule that someone is supposed to
 * remember. A rule someone has to remember is a rule that holds until the first
 * hurried change, and this project has a documented history of exactly that:
 * six claims across two rounds were contradicted by their own measurements, and
 * in most cases the fix was a type rather than a sentence. The failure mode is
 * not carelessness, it is that prose cannot be run.
 *
 * So the audit is a program. It parses the source with the TypeScript
 * compiler, finds every asset symbol written as a string literal, and separates
 * the two kinds that a grep cannot tell apart:
 *
 *   - **a symbol in code** — a decision the program will make, and therefore
 *     architecture, and therefore the thing PHASE 1 is about;
 *   - **a symbol in a comment** — a record of a measurement. The strategies
 *     here have comments saying "over 2096 daily BTCUSDT bars this makes
 *     −27.57%", and those are not hardcodes, they are the findings. Counting
 *     them would drown the real thing in noise, which is the fate every
 *     hand-written audit list suffers.
 *
 * The distinction is the whole value. A grep for BTCUSDT returns 110 hits and
 * means nothing; this returns the two places a program actually decides which
 * market it is talking about, and it keeps returning them tomorrow.
 *
 * The allowlist is a table with reasons, not a comment saying "ignore these".
 * An entry that stops being true should fail a test, and the test is in
 * `architecture-lint.test.ts` — it pins the exact set, so removing a hardcode
 * does not silently widen the exception for it.
 *
 * **On the parser.** The project's own `typescript` is the 7.x native port,
 * whose scanner hangs on ordinary input in this environment, so this imports
 * `typescript-5` — a dev-only alias of 5.9.3, declared in package.json so the
 * tool also works in CI. The typechecker is untouched and still runs on 7.0.2.
 * Two parsers in one project is a cost, and it is cheaper than an audit that
 * cannot be trusted because the tool that produces it sometimes does not return.
 *
 * And the second attempt used a scanner rather than a parser, and reported zero
 * violations in a file that has one. The scanner walks into a multi-line
 * template literal and never walks out. That is written up at `isStringLike`
 * because it is the most dangerous shape of bug this kind of tool can have: not
 * a crash, not a wrong answer that looks wrong, but a tool that stops seeing
 * and is still trusted.
 */

import ts from 'typescript-5';

import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Directories the audit does not descend into at all. */
const SKIPPED = new Set(['test-support', 'node_modules', '.next', 'fixtures']);

/** Path prefixes, relative to src/backend, allowed to name a symbol in code. */
export interface Exception {
    readonly path: string;
    readonly reason: string;
}

/**
 * Where naming a market in code is the job, not a hardcode.
 *
 * `config` is where a default belongs — the roadmap asks for exactly this, and
 * a default chosen by configuration is the difference between "BTC is the
 * system" and "BTC is what is switched on right now". `research` measures a
 * specific series on purpose; a coin flip named there would be a different
 * experiment, not an accident.
 *
 * Everything else is a decision the domain makes, and that is the list this
 * audit exists to shorten.
 */
export const EXCEPTIONS: readonly Exception[] = [
    {
        path: 'config',
        reason: 'A configurable default is the correct home for a market name.',
    },
    {
        path: 'research',
        reason: 'Research names its subject on purpose; that is the experiment.',
    },
];

export type OccurrenceKind = 'code' | 'comment';

export interface Occurrence {
    readonly file: string;
    readonly line: number;
    readonly value: string;
    readonly kind: OccurrenceKind;
    /** True when the file is exempt by table, false when it is a violation. */
    readonly exempted: boolean;
}

/** Quote currencies a crypto instrument can be written against. */
const QUOTES = ['USDT', 'USDC', 'BUSD', 'USD', 'EUR', 'BTC', 'ETH'];

/**
 * Whether a string names a market rather than merely mentioning one.
 *
 * The bare base assets are included because `BTC` on its own is a hardcode too
 * — a comparison `price === 'BTC'` is the same decision as `=== 'BTCUSDT'`, and
 * a filter that only caught the pair would miss it.
 */
export function looksLikeSymbol(value: string): boolean {
    const trimmed = value.trim();

    if (trimmed === 'BTC' || trimmed.toLowerCase() === 'bitcoin') {
        return true;
    }

    return QUOTES.some(
        (quote) =>
            trimmed.length > quote.length &&
            trimmed.toUpperCase().endsWith(quote) &&
            /^[A-Z0-9]+$/.test(trimmed),
    );
}

export function isExempt(relativePath: string): boolean {
    const top = relativePath.split(/[\\/]/)[0] ?? '';

    return EXCEPTIONS.some((exception) => exception.path === top);
}

export function listSources(root: string): string[] {
    const found: string[] = [];

    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory)) {
            if (SKIPPED.has(entry)) {
                continue;
            }

            const full = join(directory, entry);

            if (statSync(full).isDirectory()) {
                walk(full);
            } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
                found.push(full);
            }
        }
    };

    walk(root);

    return found.sort();
}

/** Maps byte offsets in a text to 1-based line numbers. */
function lineIndexer(text: string): (offset: number) => number {
    const starts: number[] = [0];

    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === '\n') {
            starts.push(index + 1);
        }
    }

    return (offset: number): number => {
        let low = 0;
        let high = starts.length - 1;

        while (low < high) {
            const middle = Math.ceil((low + high) / 2);

            if (starts[middle]! <= offset) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }

        return low + 1;
    };
}

/**
 * Every market mention inside a block of prose.
 *
 * A symbol in a comment is not a token — the scanner hands back the comment as
 * one opaque blob — so the text has to be searched, and the first version of
 * this file did not, and reported zero documented symbols for a codebase that
 * has dozens. That is the same failure this project has hit six times: a
 * number with no third answer, so nothing could contradict it.
 *
 * Candidates are maximal alphanumeric runs, which keeps `btcusdt-1d.csv` from
 * being read as one identifier and `USDT` alone from being read as a market
 * choice — it is the quote currency, and naming it says nothing about which
 * market the program is about.
 */
export function mentionsInProse(text: string): string[] {
    const found: string[] = [];

    for (const match of text.matchAll(/[A-Za-z0-9_]+/g)) {
        const candidate = match[0];

        if (
            candidate.length > 1 &&
            (candidate === 'BTC' ||
                candidate.toLowerCase() === 'bitcoin' ||
                looksLikeSymbol(candidate.toUpperCase()))
        ) {
            found.push(candidate);
        }
    }

    return found;
}

/**
 * True for a node that the parser built as part of a string or template.
 *
 * These ranges are what gets masked out before comments are looked for, and
 * masking them is the whole reason this file uses a parser rather than a
 * scanner. A bare `ts.createScanner` walks into a multi-line template literal,
 * sees the `}` that continues it, and never comes back: on `api/routes/health.ts`
 * it stopped 187 characters from the end of a 7742-character file and reported
 * no `'BTCUSDT'` at all.
 *
 * That is worth stating plainly, because it is the worst way for an audit to
 * fail. It did not crash and it did not look wrong. It reported zero
 * violations in a file that has one, on line 63, in plain sight — and a guard
 * that quietly stops seeing is worse than no guard, because it is trusted.
 */
function isStringLike(node: ts.Node): boolean {
    return (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
    );
}

export function scanFile(fullPath: string, root: string): Occurrence[] {
    const text = readFileSync(fullPath, 'utf8');
    const relativePath = relative(root, fullPath).split(sep).join('/');
    const lineAt = lineIndexer(text);
    const exempt = isExempt(relativePath);
    const occurrences: Occurrence[] = [];

    const source = ts.createSourceFile(
        relativePath,
        text,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
    );

    // Blank out every string and template span, keeping the length identical so
    // that offsets still address the original text. A `//` inside a string is
    // then invisible, and whatever is left really is a comment.
    const mask = text.split('');

    const visit = (node: ts.Node): void => {
        if (isStringLike(node)) {
            const start = node.getStart(source);
            const end = node.getEnd();

            for (let offset = start; offset < end; offset += 1) {
                mask[offset] = ' ';
            }

            if (
                (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
                looksLikeSymbol(node.text)
            ) {
                occurrences.push({
                    file: relativePath,
                    line: lineAt(start),
                    value: node.text,
                    kind: 'code',
                    exempted: exempt,
                });
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(source);

    // Comments live in the gaps between nodes, so the masked text is where they
    // have to be found. The parser never emits a node for one, which is what
    // makes this the complement of the walk above rather than a duplicate.
    const blanked = mask.join('');

    for (const match of blanked.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) {
        const body = match[0];
        const start = match.index ?? 0;

        for (const value of mentionsInProse(body)) {
            occurrences.push({
                file: relativePath,
                line: lineAt(start),
                value,
                kind: 'comment',
                exempted: true,
            });
        }
    }

    return occurrences.sort((a, b) => a.line - b.line);
}

export interface Report {
    readonly occurrences: readonly Occurrence[];
    /** Symbols written in comments — a record of a measurement, not a decision. */
    readonly documented: number;
    /** Symbols in code, in an exempted layer. */
    readonly configured: number;
    /** Symbols in code, in the domain. Each one is an architectural hardcode. */
    readonly violations: readonly Occurrence[];
}

/** Scans a tree and separates decisions from documentation. */
export function audit(root: string): Report {
    const occurrences = listSources(root).flatMap((file) => scanFile(file, root));

    return {
        occurrences,
        documented: occurrences.filter((o) => o.kind === 'comment').length,
        configured: occurrences.filter((o) => o.kind === 'code' && o.exempted).length,
        violations: occurrences.filter((o) => o.kind === 'code' && !o.exempted),
    };
}
