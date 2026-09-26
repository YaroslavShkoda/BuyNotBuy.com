import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const STYLES_ROOT = join(process.cwd(), 'src', 'app', 'styles');

function collectStylesheets(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) return collectStylesheets(path);

        return entry.name.endsWith('.css') ? [path] : [];
    });
}

const stylesheets = collectStylesheets(STYLES_ROOT);

/**
 * A byte order mark is a trap in a stylesheet, and a quiet one.
 *
 * At the very start of a file a browser swallows it, so opening the raw CSS
 * looks perfect and the rule parses. Bundled with the other stylesheets the
 * same mark lands in the middle of the combined sheet, where it is no longer an
 * encoding signature but an invalid token: the parser meets a character it does
 * not expect and drops the rule that follows. The rule that was lost carried a
 * card's border and background, and the card rendered with no frame at all.
 *
 * Nothing else in the build complains. The rule is present in the output text
 * when you go looking for it, the file is valid UTF-8, and the stylesheet
 * passes every check that reads it as text.
 */
describe('stylesheet encoding', () => {
    it('finds the stylesheets to check', () => {
        expect(stylesheets.length).toBeGreaterThan(0);
    });

    it('carries no byte order mark in any stylesheet', () => {
        const marked = stylesheets
            .map((path) => ({ path, bytes: readFileSync(path) }))
            .filter(({ bytes }) => bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
            .map(({ path }) => path.slice(STYLES_ROOT.length + 1));

        expect(marked).toEqual([]);
    });

    it('carries no byte order mark anywhere inside a stylesheet', () => {
        // The leading case above is caught by any editor. This one is not: a mark
        // partway down survives a copy-paste, a merge or a re-save by a tool that
        // does not know what the file is, and it breaks the rule directly after
        // it while leaving every byte before it untouched.
        const embedded = stylesheets
            .filter((path) => readFileSync(path, 'utf8').includes('﻿'))
            .map((path) => path.slice(STYLES_ROOT.length + 1));

        expect(embedded).toEqual([]);
    });
});
