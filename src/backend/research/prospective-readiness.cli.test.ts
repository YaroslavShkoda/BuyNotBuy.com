import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('./prospective-readiness.cli.ts', import.meta.url));
const receipt = {
    format: 'research-registration/1', status: 'owner-accepted',
    protocolHashFormat: 'sha256-crlf-to-lf/1',
    protocolSha256: 'b39f1a057364899c8cbb48d70753e23a696697487028f01903d901cf72bfdc81',
    approvedCommit: '0941bc2babf898b9f18c7048798b76a02a319a54',
    acceptedAt: '2026-10-28T05:19:15.203Z',
    evidenceUrl: 'https://linear.app/yaroslavshkoda/issue/YAR-84/stage-6-statistical-evidence-and-confidence-calibration-research',
};

function run(receiptValue: unknown) {
    const directory = mkdtempSync(join(tmpdir(), 'bnb-registration-'));
    try {
        const path = join(directory, 'receipt.json');
        if (receiptValue !== undefined) writeFileSync(path, JSON.stringify(receiptValue));
        return spawnSync(process.execPath, ['--import=tsx', cli, path], {
            encoding: 'utf8', timeout: 10_000,
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe('readiness CLI consumes the selected registration receipt', () => {
    it('reports owner acceptance and its actual later window, with no evidence from old development fixtures', () => {
        const child = run(receipt);
        expect(child.status, child.stderr).toBe(0);
        const result = JSON.parse(child.stdout);
        expect(result.preregistration).toBe('OWNER_ACCEPTED');
        expect(result.protocolHashFormat).toBe('sha256-crlf-to-lf/1');
        expect(result.protocolSha256).toBe(receipt.protocolSha256);
        expect(result.registration.effectiveStart).toBe('2026-10-28T05:19:15.203Z');
        expect(result.inventory.every((item: { readiness: { eligibleBars: number; outcome: string } }) =>
            item.readiness.eligibleBars === 0 && item.readiness.outcome === 'INCONCLUSIVE')).toBe(true);
        expect(result.confidenceIntervals).toBeNull();
        expect(result.independentVenueProspectiveCollection).toBe('NOT_STARTED');
    });

    it('refuses a tampered protocol binding rather than returning a clean readiness report', () => {
        const child = run({ ...receipt, protocolSha256: '0'.repeat(64) });
        expect(child.status).not.toBe(0);
        expect(child.stderr).toMatch(/hash mismatch/i);
        expect(child.stdout).not.toContain('OWNER_ACCEPTED');
    });

    it('keeps the absent-receipt path unregistered', () => {
        const child = run(undefined);
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout).preregistration).toBe('NOT_ACCEPTED');
    });
});
