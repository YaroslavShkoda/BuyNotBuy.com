import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
    EXCEPTIONS,
    audit,
    isExempt,
    listSources,
    looksLikeSymbol,
    mentionsInProse,
    scanFile,
} from './architecture-lint.js';

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const realRoot = join(process.cwd(), 'src', 'backend');

/** Writes a tree of files and returns its root, for the scanner under test. */
const tree = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'archlint-'));

    for (const [path, content] of Object.entries(files)) {
        const full = join(root, path);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content, 'utf8');
    }

    return root;
};

describe('a symbol in code is a decision, and a symbol in prose is a record', () => {
    it('separates the two', () => {
        const root = tree({
            'thing.ts':
                "export const market = 'BTCUSDT';\n// measured on BTCUSDT daily bars\n",
        });
        const found = scanFile(join(root, 'thing.ts'), root);

        const code = found.filter((o) => o.kind === 'code');
        const prose = found.filter((o) => o.kind === 'comment');

        expect(code).toHaveLength(1);
        expect(code[0]?.line).toBe(1);
        expect(prose.map((o) => o.value)).toEqual(['BTCUSDT']);
    });

    it('does not mistake a symbol inside a string for a comment', () => {
        // The mask is what makes this work. A `//` that lives inside a string
        // is not a comment, and a `/*` inside one is not the start of a block.
        const root = tree({
            'thing.ts': "const url = 'https://x/BTCUSDT';\nconst p = '/* BTCUSDT */';\n",
        });

        expect(scanFile(join(root, 'thing.ts'), root).filter((o) => o.kind === 'comment')).toEqual(
            [],
        );
    });

    it('sees past a multi-line template literal instead of stopping inside it', () => {
        // This is the regression that made the first version of this tool
        // report a clean bill of health for a file that has a hardcode on line
        // 6. A bare `ts.createScanner` enters the template, reads the `}` that
        // continues it, and never returns — so it found nothing at all, and
        // nothing about the output said so.
        const root = tree({
            'thing.ts': [
                'const message = `',
                '  database schema v${version} is newer than this build understands',
                '  (v${SUPPORTED})`,',
                "const market = 'BTCUSDT';",
                '// and BTCUSDT appears here too',
                '',
            ].join('\n'),
        });
        const found = scanFile(join(root, 'thing.ts'), root);

        expect(found.filter((o) => o.kind === 'code').map((o) => o.value)).toEqual(['BTCUSDT']);
        expect(found.filter((o) => o.kind === 'code')[0]?.line).toBe(4);
        expect(found.filter((o) => o.kind === 'comment')).toHaveLength(1);
    });

    it('reads a template head and tail as the single string they are', () => {
        const root = tree({ 'thing.ts': "const x = `a ${'BTCUSDT'} b`;\n" });
        const code = scanFile(join(root, 'thing.ts'), root).filter((o) => o.kind === 'code');

        // A template splits into three nodes and two gaps; the symbol inside the
        // expression is real code and must be counted once, not zero or twice.
        expect(code.map((o) => o.value)).toEqual(['BTCUSDT']);
    });
});

describe('what counts as naming a market', () => {
    it('takes a pair', () => {
        expect(looksLikeSymbol('BTCUSDT')).toBe(true);
        expect(looksLikeSymbol('ETHUSDC')).toBe(true);
    });

    it('takes a bare base asset, because that is the same decision', () => {
        // A filter that only caught the pair would miss `price === 'BTC'`, which
        // is the identical hardcode written shorter.
        expect(looksLikeSymbol('BTC')).toBe(true);
    });

    it('leaves the quote currency alone', () => {
        // Every comment in this project mentions USDT and almost none of them
        // are choosing a market. Counting them would bury the two that are.
        expect(looksLikeSymbol('USDT')).toBe(false);
        expect(looksLikeSymbol('USDC')).toBe(false);
    });

    it('leaves indicator names and ordinary words alone', () => {
        for (const word of ['RSI', 'EMA', 'donchian', 'consensus', '1h', 'BTC', 'X']) {
            expect(looksLikeSymbol(word)).toBe(word === 'BTC');
        }
    });

    it('reads prose the way a reader does, not the way a lexer does', () => {
        // A filename is a mention of the market, not an identifier.
        expect(mentionsInProse('over 2096 bars of btcusdt-1d.csv and bitcoin')).toEqual([
            'btcusdt',
            'bitcoin',
        ]);
    });
});

describe('the exemption table is a decision, and is pinned', () => {
    it('holds exactly the two layers that earn it', () => {
        // Pinned so that widening the exception is a visible act in a diff. An
        // audit whose allowlist drifts is an audit that will explain anything.
        expect(EXCEPTIONS.map((e) => e.path)).toEqual(['config', 'research']);
    });

    it('gives every exemption a reason', () => {
        for (const exception of EXCEPTIONS) {
            expect(exception.reason.length).toBeGreaterThan(20);
        }
    });

    it('exempts by top-level directory only', () => {
        expect(isExempt('config/market.config.ts')).toBe(true);
        expect(isExempt('research/dataset.ts')).toBe(true);
        expect(isExempt('api/routes/config.ts')).toBe(false);
        expect(isExempt('market/providers/binance.provider.ts')).toBe(false);
    });
});

describe('this codebase, audited', () => {
    it('finds the two hardcodes and only the two', () => {
        // Pinned deliberately. Removing a hardcode means editing this list in
        // the same commit, which is the point: the number cannot fall silently,
        // and it cannot be made to look better by loosening the check.
        const report = audit(realRoot);

        expect(report.violations.map((v) => `${v.file}:${v.line} ${v.value}`)).toEqual([
            'api/routes/health.ts:63 BTCUSDT',
            'observability/health.registry.ts:230 BTCUSDT',
        ]);
    });

    it('reads a normal file as one', () => {
        // The regression test from above, pointed at a real file that contains
        // the multi-line template literal that stopped the first scanner.
        const report = audit(realRoot);
        const health = report.occurrences.filter(
            (o) => o.file === 'api/routes/health.ts' && o.kind === 'code',
        );

        expect(health).toHaveLength(1);
        expect(health[0]?.line).toBe(63);
    });

    it('separates the strategies’ written findings from their decisions', () => {
        // The strategies are the clearest case for the distinction: their
        // comments record what was measured on BTC, which is a finding and must
        // survive, while a symbol in their code would be a rule choosing a
        // market and would be the actual defect.
        const report = audit(realRoot);
        const strategyProse = report.occurrences.filter(
            (o) => o.file.startsWith('strategies/') && o.kind === 'comment',
        );
        const strategyCode = report.occurrences.filter(
            (o) => o.file.startsWith('strategies/') && o.kind === 'code',
        );

        expect(strategyProse.length).toBeGreaterThan(5);
        expect(strategyCode).toEqual([]);
    });

    it('never reports documentation as a violation, for any file', () => {
        // The invariant the whole classification rests on. If this ever fails,
        // the numbers in the report are not about what they claim to be about.
        fc.assert(
            fc.property(fc.constantFrom(...listSources(realRoot)), (file) => {
                const found = scanFile(file, realRoot);

                expect(found.filter((o) => o.kind === 'comment' && !o.exempted)).toEqual([]);
            }),
            { numRuns: 200 },
        );
    });

    it('reports every code occurrence as either exempt or a violation, never neither', () => {
        const report = audit(realRoot);
        const code = report.occurrences.filter((o) => o.kind === 'code');

        expect(code).toHaveLength(report.configured + report.violations.length);
    });
});
