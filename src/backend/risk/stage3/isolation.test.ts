import { readFileSync } from 'node:fs';
import ts from 'typescript-5';
import { expect, it } from 'vitest';

it('keeps Stage 3 production imports limited to schemas, Zod and output types', () => {
    const allowed = new Set(['zod', './schema.js', '../../types/margin-assessment.js']);
    const forbiddenGlobals = new Set(['process', 'fetch', 'Date', 'console', 'require', 'eval', 'setTimeout', 'setInterval']);
    for (const file of ['schema.ts', 'validation.ts']) {
        const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
        function inspect(node: ts.Node): void {
            if (ts.isImportDeclaration(node)) {
                expect(ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
                if (ts.isStringLiteral(node.moduleSpecifier)) expect(allowed.has(node.moduleSpecifier.text)).toBe(true);
                expect(node.importClause).toBeDefined();
                if (ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.includes('/types/')) {
                    expect(node.importClause?.isTypeOnly).toBe(true);
                }
            }
            if (ts.isCallExpression(node)) expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
            if (ts.isIdentifier(node)) expect(forbiddenGlobals.has(node.text)).toBe(false);
            ts.forEachChild(node, inspect);
        }
        inspect(source);
    }
});

it('erases the output vocabulary completely at runtime', () => {
    const text = readFileSync(new URL('../../types/margin-assessment.ts', import.meta.url), 'utf8');
    const emitted = ts.transpileModule(text, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true },
    });
    expect(emitted.outputText.trim()).toBe('export {};');
});
