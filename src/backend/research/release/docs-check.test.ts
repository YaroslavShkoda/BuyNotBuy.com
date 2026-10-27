import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkReleaseStatus, lockfileFingerprint } from './docs-check.js';

const baseline = () => ({
    format: 'release-status/2',
    lockfileHashFormat: 'sha256-crlf-to-lf/1',
    baseCommit: '18e0034a407c0e6b7281efd0549e8dd09f3eb46d',
    checkedAt: '2026-10-25T00:00:00.000Z',
    workingTree: 'uncommitted',
    lockfileSha256: 'a'.repeat(64),
    decision: 'NO_GO',
    documents: ['docs/release-status.md'],
    environments: [
        { name: 'local-lab', status: 'tested', deployedCommit: null, markets: ['BTCUSDT', 'ETHUSDT'], provider: 'mock', schemaVersion: 25, evidence: 'docs/staging-rehearsal.md' },
        { name: 'staging', status: 'not_tested', deployedCommit: null, markets: null, provider: null, schemaVersion: null, evidence: null },
        { name: 'production', status: 'not_tested', deployedCommit: null, markets: null, provider: null, schemaVersion: null, evidence: null },
    ],
});
const options = { lockfileSha256: 'a'.repeat(64), exists: () => true, commitExists: () => true };

describe('release environment evidence consistency', () => {
    it('allows a verified local lab while remote environments remain unknown', () => {
        expect(checkReleaseStatus(baseline(), options)).toEqual([]);
    });
    it('refuses to infer activated production markets from an untested environment', () => {
        const status = baseline();
        status.environments[2]!.markets = ['ETHUSDT'];
        expect(checkReleaseStatus(status, options).join(' ')).toContain('unknown');
    });
    it('detects changed lockfile, unknown commit and missing evidence paths', () => {
        const errors = checkReleaseStatus(baseline(), {
            lockfileSha256: 'b'.repeat(64), exists: () => false, commitExists: () => false,
        }).join(' ');
        expect(errors).toContain('lockfile');
        expect(errors).toContain('commit');
        expect(errors).toContain('docs/staging-rehearsal.md');
    });
    it('refuses GO without owner acceptance and actual staging evidence', () => {
        expect(checkReleaseStatus({ ...baseline(), decision: 'GO' }, options).join(' ')).toContain('NO_GO');
    });
    it('requires a deployed commit identity for tested remote environments', () => {
        const status = baseline();
        status.environments[1] = { ...status.environments[0]!, name: 'staging' };
        expect(checkReleaseStatus(status, options).join(' ')).toContain('deployed commit');
    });
    it('rejects malformed records and paths escaping the repository', () => {
        expect(checkReleaseStatus({}, options).length).toBeGreaterThan(0);
        expect(checkReleaseStatus({ ...baseline(), documents: ['../secret'] }, options).join(' ')).toContain('path');
    });
});

describe('lockfile checkout fingerprint', () => {
    it('equates LF and CRLF without reserializing the lockfile', () => {
        const lf = Buffer.from('{\n  \"version\": \"1.0.0\"\n}\n');
        const crlf = Buffer.from(lf.toString('utf8').replaceAll('\n', '\r\n'));
        const expected = createHash('sha256').update(lf).digest('hex');
        expect(lockfileFingerprint(lf)).toBe(expected);
        expect(lockfileFingerprint(crlf)).toBe(expected);
    });
    it.each([Buffer.from('a\rb'), Buffer.from('\uFEFF{}\n'), Buffer.from('{ \"a\": 1 }'), Buffer.from([0xff, 0xc3, 0x28])])('preserves all bytes apart from CRLF: %j', (bytes) => {
        expect(lockfileFingerprint(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    });
    it('rejects the old ambiguous hash format even when its digest happens to match', () => {
        expect(checkReleaseStatus({ ...baseline(), format: 'release-status/1' }, options).join(' ')).toContain('format');
        expect(checkReleaseStatus({ ...baseline(), lockfileHashFormat: 'sha256-json/1' }, options).join(' ')).toContain('lockfileHashFormat');
    });
});
