import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
    EXCEPTIONS,
    audit,
    isExempt,
    listSources,
    looksLikeMarketDefault,
    looksLikeMarketIdentifier,
    looksLikeSymbol,
    mentionsInProse,
    scanFile,
} from './architecture-lint.js';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

    it('takes an identifier named after a market, in any spelling', () => {
        expect(looksLikeMarketIdentifier('btcSymbol')).toBe(true);
        expect(looksLikeMarketIdentifier('BTC_PRICE')).toBe(true);
        expect(looksLikeMarketIdentifier('bitcoinCandles')).toBe(true);
        expect(looksLikeMarketIdentifier('marketCandles')).toBe(false);
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

describe('PHASE 0.2 names two kinds of target, and a guard that watched one is half a guard', () => {
    it('catches a market named in an identifier, not in a literal', () => {
        // `const btcSymbol = ...` says which market the code is about at the
        // moment it is declared, and there is no string literal anywhere near
        // it. A rule that only reads literals cannot see it at all.
        const root = tree({ 'thing.ts': "const btcSymbol = 'BTCUSDT';\n" });
        const named = scanFile(join(root, 'thing.ts'), root).filter(
            (o) => o.via === 'identifier',
        );

        expect(named.map((o) => o.value)).toEqual(['btcSymbol']);
    });

    it('catches a default that could carry a market', () => {
        const root = tree({ 'thing.ts': 'const defaultSymbol = read();\n' });
        const named = scanFile(join(root, 'thing.ts'), root).filter(
            (o) => o.via === 'identifier',
        );

        expect(named.map((o) => o.value)).toEqual(['defaultSymbol']);
    });

    it('catches it however it is spelled, not only as PHASE 0.2 writes it', () => {
        // The roadmap names two spellings. A rule that fires on those two only
        // is a rule waiting to be spelled `defaultTicker` instead.
        for (const name of [
            'defaultSymbol',
            'defaultAsset',
            'defaultMarket',
            'defaultTicker',
            'defaultInstrument',
            'DEFAULT_SYMBOL',
        ]) {
            expect(looksLikeMarketDefault(name)).toBe(true);
        }
    });

    it('leaves defaults that carry no market alone', () => {
        // This codebase has `defaultCandleLimit` fifteen times and
        // `defaultQuery` four times. Counting those would bury the finding.
        for (const name of ['defaultCandleLimit', 'defaultQuery', 'defaultLimit', 'defaults']) {
            expect(looksLikeMarketDefault(name)).toBe(false);
        }
    });

    it('counts a declaration once, not every time it is referenced', () => {
        // A constant named BTC_MARKER used twelve times is one hardcode, and a
        // report that says twelve would be read as noise and switched off.
        const root = tree({
            'thing.ts': [
                'const BTC_MARKER = 1;',
                'const a = BTC_MARKER;',
                'const b = BTC_MARKER;',
                'const c = BTC_MARKER;',
                '',
            ].join('\n'),
        });

        expect(
            scanFile(join(root, 'thing.ts'), root).filter((o) => o.via === 'identifier'),
        ).toHaveLength(1);
    });

    it('ignores a market word inside a comment, which is the whole distinction', () => {
        const root = tree({ 'thing.ts': '// btcSymbol used to live here\nconst x = 1;\n' });

        expect(
            scanFile(join(root, 'thing.ts'), root).filter((o) => o.via === 'identifier'),
        ).toEqual([]);
    });

    it('has no market-named declaration in the domain today', () => {
        // Measured, not assumed: `defaultSymbol` and `defaultAsset`, which
        // PHASE 0.2 lists as things to find, are absent from this codebase
        // entirely. The ten that exist are research scripts naming their
        // subject, which is the experiment rather than a decision about the
        // system.
        const report = audit(realRoot);
        const named = report.occurrences.filter((o) => o.via === 'identifier');

        expect(named).toHaveLength(10);
        expect(named.filter((o) => !o.exempted)).toEqual([]);
        expect(named.every((o) => o.file.startsWith('research/'))).toBe(true);
    }, 30000);

    it('reports no defaultSymbol and no defaultAsset in code', () => {
        // Asked as a raw text search this comes back true, because this file
        // and two others say the words out loud in order to explain that they
        // are absent. A search that cannot tell a mention from a declaration
        // would have "found" the absence and reported it as a presence, which
        // is the failure this whole file exists to avoid — so the question is
        // asked of the audit, which can tell the difference.
        const offenders = listSources(realRoot).flatMap((file) =>
            scanFile(file, realRoot)
                .filter((o) => o.via === 'identifier' && looksLikeMarketDefault(o.value))
                .map((o) => `${o.file}:${o.line} ${o.value}`),
        );

        expect(offenders).toEqual([]);
    }, 30000);
});

describe('this codebase, audited', () => {
    it('finds no hardcoded market in the domain, and the number is pinned anyway', () => {
        // It was two, and the two are gone. The list is pinned rather than
        // deleted so that the next one is a visible edit in a diff: a guard
        // that stops counting is not the same as a guard that reached zero.
        const report = audit(realRoot);

        expect(report.violations.map((v) => `${v.file}:${v.line} ${v.value}`)).toEqual([]);
    }, 30000);

    it('reads a normal file as one, and finds nothing hardcoded in it', () => {
        // The regression test from above, pointed at a real file. It used to
        // contain the audit's one domain hardcode on line 63, one line below a
        // template literal spanning three lines — which is what the first
        // scanner walked into and never came out of. A file that was read
        // correctly is exactly the file worth keeping this pointed at.
        const report = audit(realRoot);
        const health = report.occurrences.filter(
            (o) => o.file === 'api/routes/health.ts' && o.kind === 'code',
        );

        expect(health).toEqual([]);
    }, 30000);

    it('still reads the whole of that file rather than stopping at the template', () => {
        // Zero findings is also what a scanner that gave up would report, so
        // zero on its own proves nothing. The proof is that the file is fully
        // read: its own comment about the vote store mentions no market, and
        // its later mentions of one are prose, and prose is found.
        const report = audit(realRoot);
        const prose = report.occurrences.filter(
            (o) => o.file === 'api/routes/health.ts' && o.kind === 'comment',
        );

        expect(prose.length).toBeGreaterThan(0);
    }, 30000);

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
    }, 30000);

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
    }, 30000);

    it('reports every code occurrence as either exempt or a violation, never neither', () => {
        const report = audit(realRoot);
        const code = report.occurrences.filter((o) => o.kind === 'code');

        expect(code).toHaveLength(report.configured + report.violations.length);
    }, 30000);
});
