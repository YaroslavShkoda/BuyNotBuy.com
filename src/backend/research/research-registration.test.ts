import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assessProspectiveReadiness } from './prospective-readiness.js';
import { validateResearchRegistration } from './research-registration.js';

const protocol = Buffer.from(`{
    "format": "prospective-research/1",
    "createdAt": "2026-10-25T19:55:00.000Z",
    "earliestCollectionStart": "2026-10-27T00:00:00.000Z"
}`);
const acceptedAt = '2026-10-28T05:19:15.203Z';
const now = Date.parse('2026-10-28T07:00:00.000Z');
const receipt = {
    format: 'research-registration/1',
    status: 'owner-accepted',
    protocolHashFormat: 'sha256-crlf-to-lf/1',
    protocolSha256: createHash('sha256').update(protocol).digest('hex'),
    approvedCommit: '0941bc2babf898b9f18c7048798b76a02a319a54',
    acceptedAt,
    evidenceUrl: 'https://linear.app/yaroslavshkoda/issue/YAR-84/stage-6-statistical-evidence-and-confidence-calibration-research',
};

describe('owner acceptance changes only future eligibility', () => {
    it('excludes the pre-acceptance 05h bar and still-open 06h bar until 07h', () => {
        const result = validateResearchRegistration(protocol, receipt, now);
        if (result.state !== 'OWNER_ACCEPTED') throw new Error('receipt was not accepted');
        const timestamps = [Date.parse('2026-10-28T05:00:00.000Z'), Date.parse('2026-10-28T06:00:00.000Z')];
        const options = { start: result.effectiveStart, registeredAt: result.acceptedAt,
            intervalMs: 3_600_000, minimumIndependentBlocks: 333 };
        expect(assessProspectiveReadiness(timestamps, { ...options, now: now - 1 }).eligibleBars).toBe(0);
        expect(assessProspectiveReadiness(timestamps, { ...options, now })).toMatchObject({
            eligibleBars: 1, calibration: 'insufficient', outcome: 'INCONCLUSIVE',
        });
    });

    it('keeps the later protocol start when approval precedes the planned window', () => {
        expect(validateResearchRegistration(protocol, { ...receipt, acceptedAt: '2026-10-26T00:00:00.000Z' }, now))
            .toMatchObject({ state: 'OWNER_ACCEPTED', effectiveStart: Date.parse('2026-10-27T00:00:00.000Z') });
    });

    it.each([undefined, { format: 'research-registration/1', status: 'draft' }])('does not register absent or draft receipts (%s)', value => {
        expect(validateResearchRegistration(protocol, value, now).state).toBe('NOT_ACCEPTED');
    });

    it('accepts CRLF transport of the exact protocol but refuses a substantive change', () => {
        expect(validateResearchRegistration(Buffer.from(protocol.toString().replaceAll('\n', '\r\n')), receipt, now).state).toBe('OWNER_ACCEPTED');
        expect(() => validateResearchRegistration(Buffer.from(protocol.toString().replace('2026-10-27', '2026-10-26')), receipt, now)).toThrow(/hash/i);
    });

    it('does not repair invalid UTF8 into an approved replacement character before hashing', () => {
        const valid = Buffer.from(protocol.toString().replace('"format"', '"note": "\ufffd", "format"'));
        const badBytes = Buffer.concat([
            valid.subarray(0, valid.indexOf(Buffer.from('\ufffd'))),
            Buffer.from([0xff]),
            valid.subarray(valid.indexOf(Buffer.from('\ufffd')) + 3),
        ]);
        const approval = { ...receipt, protocolSha256: createHash('sha256').update(valid).digest('hex') };
        expect(validateResearchRegistration(valid, approval, now).state).toBe('OWNER_ACCEPTED');
        expect(() => validateResearchRegistration(badBytes, approval, now)).toThrow();
    });

    it.each([
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), protocol]),
        Buffer.from(protocol.toString().replace('\n', '\r')),
        Buffer.from(protocol.toString().replace('"format"', ' "format"')),
    ])('does not normalize BOM, lone CR or other whitespace into the approved bytes', changed => {
        expect(() => validateResearchRegistration(changed, receipt, now)).toThrow();
    });

    it.each([
        { protocolSha256: '0'.repeat(64) },
        { protocolHashFormat: 'json-reserialized/1' },
        { format: 'research-registration/2' },
        { acceptedAt: '2026-10-29T00:00:00.000Z' },
        { acceptedAt: '2026-10-24T00:00:00.000Z' },
        { acceptedAt: '2026-02-30T00:00:00.000Z' },
        { acceptedAt: '2026-10-28' },
        { evidenceUrl: 'http://linear.app/yaroslavshkoda/issue/YAR-84' },
        { evidenceUrl: 'https://evil.example/claimed-approval' },
        { approvedCommit: 'main' },
        { claimedProbability: 0.9 },
    ])('fails closed for invalid or contradictory receipt %j', mutation => {
        expect(() => validateResearchRegistration(protocol, { ...receipt, ...mutation }, now)).toThrow();
    });

    it.each([0, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('refuses invalid check clock %s', clock => {
        expect(() => validateResearchRegistration(protocol, receipt, clock)).toThrow();
    });

    it('refuses future protocol formats even if the receipt hash is made to match', () => {
        const changed = Buffer.from(protocol.toString().replace('prospective-research/1', 'prospective-research/2'));
        expect(() => validateResearchRegistration(changed, {
            ...receipt, protocolSha256: createHash('sha256').update(changed).digest('hex'),
        }, now)).toThrow();
    });
});
