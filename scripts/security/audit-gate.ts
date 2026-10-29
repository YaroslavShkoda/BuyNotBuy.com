import { z } from 'zod';

const severity = z.enum(['info', 'low', 'moderate', 'high', 'critical']);
const advisorySchema = z.looseObject({ url: z.url(), severity, source: z.number().int() });
const vulnerabilitySchema = z.looseObject({
    name: z.string().min(1), severity,
    via: z.array(z.union([z.string().min(1), advisorySchema])).min(1),
    range: z.string(), nodes: z.array(z.string()),
    fixAvailable: z.union([z.boolean(), z.looseObject({ name: z.string(), version: z.string(), isSemVerMajor: z.boolean() })]),
});
const reportSchema = z.looseObject({
    auditReportVersion: z.literal(2),
    vulnerabilities: z.record(z.string(), vulnerabilitySchema),
    metadata: z.looseObject({ vulnerabilities: z.looseObject({ total: z.number().int().nonnegative() }) }),
});
const exceptionSchema = z.strictObject({
    package: z.string().trim().min(1), advisory: z.url(),
    owner: z.string().trim().min(1), reason: z.string().trim().min(1), issue: z.url(),
    expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
        const timestamp = Date.parse(`${date}T00:00:00Z`);
        return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
    }, 'Expected a real UTC calendar date'),
});

export function evaluateAudit(input: unknown, exceptionInput: unknown, now = new Date()) {
    const report = reportSchema.parse(input);
    if ('error' in report) throw new Error('npm audit returned an error');
    if (report.metadata.vulnerabilities.total !== Object.keys(report.vulnerabilities).length) {
        throw new Error('Incomplete audit report: vulnerability total disagrees with entries');
    }
    const exceptions = z.array(exceptionSchema).parse(exceptionInput);
    const expired = exceptions.filter((item) => Date.parse(`${item.expires}T00:00:00Z`) <= now.getTime());
    const findings = [];

    function sources(name: string, seen = new Set<string>()): z.infer<typeof advisorySchema>[] {
        if (seen.has(name)) throw new Error(`Cyclic audit via reference: ${name}`);
        const row = report.vulnerabilities[name];
        if (!row) throw new Error(`Missing audit via reference: ${name}`);
        return row.via.flatMap((via) => typeof via === 'string'
            ? sources(via, new Set([...seen, name])) : [via]);
    }

    for (const [name, row] of Object.entries(report.vulnerabilities).sort(([a], [b]) => a.localeCompare(b))) {
        const advisories = sources(name);
        if (row.severity !== 'high' && row.severity !== 'critical') continue;
        for (const advisory of advisories) {
            const exception = exceptions.find((item) => item.package === name && item.advisory === advisory.url
                && Date.parse(`${item.expires}T00:00:00Z`) > now.getTime());
            findings.push({ package: name, severity: row.severity, advisory: advisory.url, source: advisory.source,
                range: row.range, nodes: row.nodes, fixAvailable: row.fixAvailable, exception: exception ?? null });
        }
    }
    const blockers = findings.filter((finding) => finding.exception === null);
    return { ok: blockers.length === 0 && expired.length === 0, blockers, findings, expired, summary: report.metadata.vulnerabilities };
}
