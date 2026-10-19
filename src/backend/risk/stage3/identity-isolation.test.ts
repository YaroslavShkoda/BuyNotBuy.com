import { readFileSync } from 'node:fs';
import ts from 'typescript-5';
import { expect, it } from 'vitest';

it('limits S3-03 imports to SHA-256, Zod and local validation/contracts', () => {
    const allowed = new Set(['node:crypto', 'zod', './validation.js', './canonicalization.js', '../../types/margin-assessment.js']);
    const forbidden = new Set(['process', 'Date', 'fetch', 'require', 'eval', 'Function', 'setTimeout', 'setInterval', 'WebSocket']);
    for (const file of ['canonicalization.ts', 'identity.ts']) {
        const ast = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
        function inspect(node: ts.Node): void {
            if (ts.isImportDeclaration(node)) {
                expect(node.importClause).toBeDefined();
                expect(ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
                if (ts.isStringLiteral(node.moduleSpecifier)) {
                    expect(allowed.has(node.moduleSpecifier.text)).toBe(true);
                    if (node.moduleSpecifier.text === 'node:crypto') {
                        expect(node.importClause?.namedBindings?.getText(ast)).toBe('{ createHash }');
                    }
                }
            }
            if (ts.isIdentifier(node)) expect(forbidden.has(node.text)).toBe(false);
            if (ts.isCallExpression(node)) expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
            ts.forEachChild(node, inspect);
        }
        inspect(ast);
    }
});
