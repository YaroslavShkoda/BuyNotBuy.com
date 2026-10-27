import { describe, expect, it } from 'vitest';
import { evaluateAudit } from './audit-gate.js';

const now = new Date('2026-10-25T12:00:00Z');
const advisory = 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc';
function report(severity = 'high') {
    return { auditReportVersion: 2, vulnerabilities: {
        widget: { name: 'widget', severity, via: [{ source: 123, name: 'widget', severity, url: advisory }], range: '<2', nodes: ['node_modules/widget'], fixAvailable: true },
    }, metadata: { vulnerabilities: { total: 1 } } };
}
const exception = {
    package: 'widget', advisory, owner: 'security-owner',
    reason: 'Temporary mitigation verified; upgrade tracked.',
    issue: 'https://linear.app/example/issue/SEC-1', expires: '2026-10-26',
};

describe('runtime dependency advisory gate', () => {
    it('blocks a high runtime advisory with actionable package, URL and fix evidence', () => {
        const result = evaluateAudit(report(), [], now);
        expect(result.ok).toBe(false);
        expect(result.blockers).toEqual([expect.objectContaining({ package: 'widget', advisory, severity: 'high', range: '<2', fixAvailable: true })]);
    });
    it.each(['critical', 'high'])('blocks %s without an exception', (severity) => {
        expect(evaluateAudit(report(severity), [], now).ok).toBe(false);
    });
    it.each(['moderate', 'low', 'info'])('reports but does not block %s', (severity) => {
        expect(evaluateAudit(report(severity), [], now).ok).toBe(true);
    });
    it('accepts only the exact package/advisory exception until its UTC expiry', () => {
        expect(evaluateAudit(report(), [exception], now).ok).toBe(true);
        expect(evaluateAudit(report(), [{ ...exception, package: 'other' }], now).ok).toBe(false);
        expect(evaluateAudit(report(), [{ ...exception, advisory: `${advisory}x` }], now).ok).toBe(false);
        expect(evaluateAudit(report(), [exception], new Date('2026-10-26T00:00:00Z')).ok).toBe(false);
    });
    it('follows transitive via references rather than silently passing a vulnerable parent', () => {
        const audit = report();
        const transitive = { ...audit, metadata: { vulnerabilities: { total: 2 } }, vulnerabilities: { ...audit.vulnerabilities, parent: { ...audit.vulnerabilities.widget, name: 'parent', via: ['widget'] } } };
        expect(evaluateAudit(transitive, [], now).blockers.map((row) => row.package)).toEqual(['parent', 'widget']);
    });
    it.each([{}, { error: { code: 'ENETWORK' } }, { auditReportVersion: 2, vulnerabilities: {} }, { ...report(), vulnerabilities: { widget: { ...report().vulnerabilities.widget, via: [] } } }])('fails closed on an invalid/incomplete audit report', (audit) => {
        expect(() => evaluateAudit(audit, [], now)).toThrow();
    });
    it.each([{ ...exception, owner: '' }, { ...exception, expires: '2026-02-30' }, { ...exception, reason: '' }, { ...exception, issue: '' }, { ...exception, extra: true }])('rejects malformed exception records', (record) => {
        expect(() => evaluateAudit(report(), [record], now)).toThrow();
    });
    it('accepts a well formed clean report', () => {
        expect(evaluateAudit({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }, [], now).ok).toBe(true);
    });
    it('requires cleanup of an expired exception even after its advisory disappeared', () => {
        const clean = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
        const result = evaluateAudit(clean, [{ ...exception, expires: '2026-10-25' }], now);
        expect(result.blockers).toEqual([]);
        expect(result.ok).toBe(false);
        expect(result.expired).toHaveLength(1);
    });
    it('rejects dangling audit references rather than hiding their source advisory', () => {
        const audit = report();
        expect(() => evaluateAudit({ ...audit, vulnerabilities: { widget: { ...audit.vulnerabilities.widget, via: ['missing'] } } }, [], now)).toThrow('Missing audit via reference');
    });
});
