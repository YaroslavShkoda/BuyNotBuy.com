import { createHash } from 'node:crypto';
import { z } from 'zod';

const safePath = z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_./-]+$/, 'invalid relative document path');
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const environment = z.object({
    name: z.enum(['local-lab', 'staging', 'production']),
    status: z.enum(['tested', 'not_tested']),
    deployedCommit: commit.nullable(),
    markets: z.array(z.string().regex(/^[A-Z0-9]+$/)).min(1).nullable(),
    provider: z.string().min(1).nullable(),
    schemaVersion: z.number().int().positive().nullable(),
    evidence: safePath.nullable(),
});
const schema = z.object({
    format: z.literal('release-status/2'),
    lockfileHashFormat: z.literal('sha256-crlf-to-lf/1'),
    baseCommit: commit,
    checkedAt: z.iso.datetime(),
    workingTree: z.literal('uncommitted'),
    lockfileSha256: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.literal('NO_GO'),
    documents: z.array(safePath).min(1),
    environments: z.array(environment).length(3),
});

interface CheckOptions {
    lockfileSha256: string;
    exists(path: string): boolean;
    commitExists(sha: string): boolean;
}

export function checkReleaseStatus(input: unknown, options: CheckOptions): string[] {
    const result = schema.safeParse(input);
    if (!result.success) {
        return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    }
    const status = result.data;
    const errors: string[] = [];
    if (status.lockfileSha256 !== options.lockfileSha256) errors.push('lockfile fingerprint changed');
    if (!options.commitExists(status.baseCommit)) errors.push('base commit is not available');
    if (new Set(status.environments.map((entry) => entry.name)).size !== 3) errors.push('environment names must be unique');
    for (const path of status.documents) {
        if (!options.exists(path)) errors.push(`missing document path ${path}`);
    }
    for (const entry of status.environments) {
        if (entry.status === 'not_tested') {
            if ([entry.deployedCommit, entry.markets, entry.provider, entry.schemaVersion, entry.evidence].some((value) => value !== null)) {
                errors.push(`${entry.name}: untested environment state must remain unknown`);
            }
        } else {
            if (entry.name !== 'local-lab' && entry.deployedCommit === null) errors.push(`${entry.name}: tested remote environment needs a deployed commit`);
            if ([entry.markets, entry.provider, entry.schemaVersion, entry.evidence].some((value) => value === null)) {
                errors.push(`${entry.name}: tested environment needs evidence and activation fields`);
            }
            if (entry.evidence !== null && !options.exists(entry.evidence)) errors.push(`missing evidence path ${entry.evidence}`);
        }
        if (entry.deployedCommit !== null && !options.commitExists(entry.deployedCommit)) errors.push(`${entry.name}: deployed commit unavailable`);
    }
    return errors;
}

/** Canonical text checkout hash: remove only CR immediately followed by LF.
 * Every other byte remains significant, including BOM, lone CR and invalid UTF8.
 * Raw source/artifact manifests use separate, unnormalized byte hashes. */
export function lockfileFingerprint(bytes: Uint8Array): string {
    const canonical = bytes.filter((byte, index) => !(byte === 13 && bytes[index + 1] === 10));
    return createHash('sha256').update(canonical).digest('hex');
}
