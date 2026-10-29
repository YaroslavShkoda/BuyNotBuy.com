import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'buynotbuy-docs-hash-'));
const cli = fileURLToPath(new URL('./docs-check.cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
const lf = `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { 'node_modules/example': { version: '1.0.0', integrity: 'sha512-original' } } }, null, 2)}\n`;

beforeAll(() => {
    execFileSync('git', ['init', '--quiet', root]);
    mkdirSync(join(root, 'no-hooks'));
    execFileSync('git', ['-c', `core.hooksPath=${join(root, 'no-hooks')}`, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'], { cwd: root });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/release-status.md'), '[Evidence](evidence.md)\n');
    writeFileSync(join(root, 'docs/evidence.md'), 'synthetic fixture\n');
    writeFileSync(join(root, 'docs/release-status.json'), JSON.stringify({
        format: 'release-status/2', lockfileHashFormat: 'sha256-crlf-to-lf/1', baseCommit, checkedAt: '2026-10-27T00:00:00.000Z',
        workingTree: 'uncommitted', lockfileSha256: createHash('sha256').update(lf).digest('hex'),
        decision: 'NO_GO', documents: ['docs/release-status.md'],
        environments: [
            { name: 'local-lab', status: 'tested', deployedCommit: null, markets: ['BTCUSDT'], provider: 'mock', schemaVersion: 25, evidence: 'docs/evidence.md' },
            ...['staging', 'production'].map(name => ({ name, status: 'not_tested', deployedCommit: null, markets: null, provider: null, schemaVersion: null, evidence: null })),
        ],
    }));
});

afterAll(() => {
    const target = realpathSync(root);
    if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith('buynotbuy-docs-hash-')) {
        throw new Error('Refusing cleanup outside the exact temporary fixture');
    }
    rmSync(target, { recursive: true, force: true });
});

function run(bytes: string) {
    writeFileSync(join(root, 'package-lock.json'), bytes);
    return spawnSync(process.execPath, ['--import', loader, cli], { cwd: root, encoding: 'utf8' });
}

describe('actual docs CLI lockfile bytes', () => {
    it.each([['LF', lf], ['CRLF', lf.replaceAll('\n', '\r\n')]])('accepts %s checkout of the same lockfile', (_name, bytes) => {
        const result = run(bytes);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });
    it.each([
        ['version', lf.replace('1.0.0', '2.0.0')],
        ['integrity', lf.replace('sha512-original', 'sha512-changed')],
        ['whitespace', `${lf} `],
        ['BOM', `\uFEFF${lf}`],
    ])('refuses changed %s bytes', (_name, bytes) => {
        const result = run(bytes);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('lockfile fingerprint changed');
    });
});
