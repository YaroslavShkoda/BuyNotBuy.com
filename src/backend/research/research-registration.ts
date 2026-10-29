import { createHash } from 'node:crypto';
import { z } from 'zod';

const timestamp = z.iso.datetime({ precision: 3 }).refine(value =>
    new Date(value).toISOString() === value, 'Timestamp must be canonical UTC');
const protocolSchema = z.object({
    format: z.literal('prospective-research/1'),
    createdAt: timestamp,
    earliestCollectionStart: timestamp,
});
const receiptSchema = z.discriminatedUnion('status', [
    z.strictObject({ format: z.literal('research-registration/1'), status: z.literal('draft') }),
    z.strictObject({
        format: z.literal('research-registration/1'),
        status: z.literal('owner-accepted'),
        protocolHashFormat: z.literal('sha256-crlf-to-lf/1'),
        protocolSha256: z.string().regex(/^[a-f0-9]{64}$/),
        approvedCommit: z.string().regex(/^[a-f0-9]{40}$/),
        acceptedAt: timestamp,
        evidenceUrl: z.literal('https://linear.app/yaroslavshkoda/issue/YAR-84/stage-6-statistical-evidence-and-confidence-calibration-research'),
    }),
]);

/** Validates a reviewed owner receipt; it is not a signature or public registry. */
export function validateResearchRegistration(protocolBytes: Uint8Array, receipt: unknown, now: number) {
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid registration check time');
    // Normalize only Git's CRLF transport difference, not JSON or other bytes.
    const canonical = Buffer.from(protocolBytes.filter((byte, index) =>
        byte !== 13 || protocolBytes[index + 1] !== 10));
    const protocolSha256 = createHash('sha256').update(canonical).digest('hex');
    const protocol = protocolSchema.parse(JSON.parse(canonical.toString('utf8')));
    const plannedStart = Date.parse(protocol.earliestCollectionStart);
    if (receipt === undefined) return {
        state: 'NOT_ACCEPTED' as const, reason: 'receipt_absent', effectiveStart: plannedStart, protocolSha256,
    };
    const parsed = receiptSchema.parse(receipt);
    if (parsed.status === 'draft') return {
        state: 'NOT_ACCEPTED' as const, reason: 'receipt_draft', effectiveStart: plannedStart, protocolSha256,
    };
    if (parsed.protocolSha256 !== protocolSha256) throw new Error('Registration protocol hash mismatch');
    const acceptedAt = Date.parse(parsed.acceptedAt);
    if (acceptedAt < Date.parse(protocol.createdAt) || acceptedAt > now) {
        throw new Error('Registration acceptance must follow protocol creation and cannot be in the future');
    }
    return {
        state: 'OWNER_ACCEPTED' as const,
        acceptedAt,
        effectiveStart: Math.max(plannedStart, acceptedAt),
        protocolSha256,
        protocolHashFormat: parsed.protocolHashFormat,
        approvedCommit: parsed.approvedCommit,
        evidenceUrl: parsed.evidenceUrl,
        evidenceScope: 'externally recorded owner acceptance; not a public registry or cryptographic identity proof',
    };
}
