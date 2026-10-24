import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { baseline } from '../risk/stage3/test-support/identity-fixtures.js';
import { runMarginAssessmentCli } from './margin-assessment.cli.js';

function capturedIo(files: Map<string, string>) {
    const out: string[] = [];
    const errors: string[] = [];

    return {
        io: {
            read: (path: string): string => {
                const text = files.get(path);
                if (text === undefined) throw new Error(`ENOENT: ${path}`);

                return text;
            },
            write: (text: string): void => {
                out.push(text);
            },
            error: (text: string): void => {
                errors.push(text);
            },
        },
        out,
        errors,
    };
}

describe('runMarginAssessmentCli', () => {
    const dir = mkdtempSync(join(tmpdir(), 'margin-assessment-cli-'));
    const inputPath = join(dir, 'input.json');

    afterEach(() => {
        rmSync(inputPath, { force: true });
    });

    it('prints one margin-assessment/1 document for a supported input', () => {
        const input = JSON.stringify(baseline());
        writeFileSync(inputPath, input, 'utf8');
        const harness = capturedIo(new Map([[inputPath, input]]));

        const code = runMarginAssessmentCli(['node', 'margin-assessment.cli.ts', inputPath], harness.io);

        expect(code).toBe(0);
        expect(harness.errors).toEqual([]);
        expect(harness.out).toHaveLength(1);
        const assessment = JSON.parse(harness.out[0]!) as { schemaVersion: string; status: string };
        expect(assessment.schemaVersion).toBe('margin-assessment/1');
        expect(assessment.status).toBe('valid');
    });

    it('explains usage and exits non-zero without an argument', () => {
        const harness = capturedIo(new Map());

        const code = runMarginAssessmentCli(['node', 'margin-assessment.cli.ts'], harness.io);

        expect(code).toBe(1);
        expect(harness.out).toEqual([]);
        expect(harness.errors.join('\n')).toContain('Usage:');
        expect(harness.errors.join('\n')).toContain('Read-only');
    });

    it('reports an unreadable file and exits non-zero', () => {
        const harness = capturedIo(new Map());

        const code = runMarginAssessmentCli(['node', 'margin-assessment.cli.ts', join(dir, 'missing.json')], harness.io);

        expect(code).toBe(1);
        expect(harness.errors.join('\n')).toContain('Cannot read input file');
    });

    it('reports invalid JSON text and exits non-zero', () => {
        const harness = capturedIo(new Map([[inputPath, '{not json']]));

        const code = runMarginAssessmentCli(['node', 'margin-assessment.cli.ts', inputPath], harness.io);

        expect(code).toBe(1);
        expect(harness.errors.join('\n')).toContain('INVALID_JSON');
    });

    it('names an unsupported scope instead of pretending to assess it', () => {
        // A foreign model id cannot be typed into the policy, and must not be:
        // the swap happens at the JSON trust boundary, exactly as a caller
        // would send it.
        const text = JSON.stringify(baseline()).replace('"generic-linear-isolated"', '"venue-x-isolated"');
        const harness = capturedIo(new Map([[inputPath, text]]));

        const code = runMarginAssessmentCli(['node', 'margin-assessment.cli.ts', inputPath], harness.io);

        expect(code).toBe(1);
        const report = harness.errors.join('\n');
        expect(report).toContain('Scope not supported');
        expect(report).toContain('venue-x-isolated');
        expect(report).toContain('UNSUPPORTED_SCOPE');
        expect(report).toContain('FORMULA_UNKNOWN');
        expect(harness.out).toEqual([]);
    });

    it('names the offending field for a malformed envelope', () => {
        const input = { ...baseline(), extra: 1 };
        const text = JSON.stringify(input);
        const harness = capturedIo(new Map([[inputPath, text]]));

        const code = runMarginAssessmentCli(['node', 'margin-assessment.cli.ts', inputPath], harness.io);

        expect(code).toBe(1);
        const report = harness.errors.join('\n');
        expect(report).toContain('(root)');
        expect(report).toContain('unrecognized_keys');
        expect(report).toContain('extra');
        expect(harness.out).toEqual([]);
    });

    it('reads the same bytes the file holds and writes nothing back', () => {
        const input = JSON.stringify(baseline());
        writeFileSync(inputPath, input, 'utf8');
        const harness = capturedIo(new Map([[inputPath, input]]));

        const code = runMarginAssessmentCli(['node', 'margin-assessment.cli.ts', inputPath], harness.io);

        expect(code).toBe(0);
        expect(readFileSync(inputPath, 'utf8')).toBe(input);
    });
});
