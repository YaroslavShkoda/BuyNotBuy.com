import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const clean = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
const vulnerable = {
    ...clean, metadata: { vulnerabilities: { total: 1 } },
    vulnerabilities: { synthetic: { name: 'synthetic', severity: 'critical', range: '*', nodes: ['node_modules/synthetic'], fixAvailable: false,
        via: [{ source: 999, severity: 'critical', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }] } },
};
function run(runtime: unknown, full: unknown, exceptions: unknown = []) {
    const dir = mkdtempSync(join(tmpdir(), 'buynotbuy-audit-'));
    dirs.push(dir);
    const paths = ['runtime.json', 'full.json', 'exceptions.json'].map((name) => join(dir, name));
    [runtime, full, exceptions].forEach((value, index) => { writeFileSync(paths[index] as string, JSON.stringify(value)); });
    return spawnSync(process.execPath, ['--import=tsx', 'scripts/security/audit-gate.cli.ts', ...paths], { encoding: 'utf8' });
}

describe('advisory gate executable (safe synthetic JSON, no dependency installation)', () => {
    it('returns 1 and actionable JSON for a critical runtime advisory', () => {
        const child = run(vulnerable, vulnerable);
        expect(child.status).toBe(1);
        expect(JSON.parse(child.stdout).runtime.blockers).toEqual([expect.objectContaining({ package: 'synthetic', severity: 'critical', source: 999, fixAvailable: false })]);
    });
    it('keeps a development-only critical advisory visible without blanket failure', () => {
        const child = run(clean, vulnerable);
        expect(child.status).toBe(0);
        expect(JSON.parse(child.stdout).full.findings).toHaveLength(1);
    });
    it('returns 2 for transport-shaped JSON and does not claim a clean audit', () => {
        const child = run({ error: { code: 'ENETWORK' } }, clean);
        expect(child.status).toBe(2);
        expect(child.stderr).toContain('could not validate its evidence');
        expect(child.stdout).toBe('');
    });
    it('rejects a malformed full report even when the runtime report is clean', () => {
        expect(run(clean, {}).status).toBe(2);
    });
    it('permits an exact reviewed exception and rejects an expired one', () => {
        const exception = { package: 'synthetic', advisory: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', owner: 'test owner', reason: 'Safe synthetic acceptance proof', issue: 'https://linear.app/example/issue/SEC-1', expires: '2099-01-01' };
        expect(run(vulnerable, vulnerable, [exception]).status).toBe(0);
        expect(run(vulnerable, vulnerable, [{ ...exception, expires: '2000-01-01' }]).status).toBe(1);
    });
});
