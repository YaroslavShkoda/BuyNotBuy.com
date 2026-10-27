import { readFileSync } from 'node:fs';
import { evaluateAudit } from './audit-gate.js';

try {
    const [runtimePath, fullPath, exceptionsPath] = process.argv.slice(2);
    if (!runtimePath || !fullPath || !exceptionsPath) {
        throw new Error('Usage: node --import=tsx scripts/security/audit-gate.cli.ts runtime.json full.json security/audit-exceptions.json');
    }
    const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
    const exceptions = read(exceptionsPath);
    const runtime = evaluateAudit(read(runtimePath), exceptions);
    // Validate the complete report too. Development advisories are visible;
    // only the runtime report decides advisory blocking policy.
    const full = evaluateAudit(read(fullPath), []);
    console.log(JSON.stringify({ policy: 'runtime-high-critical', runtime, full: { summary: full.summary, findings: full.findings } }, null, 2));
    if (!runtime.ok) process.exitCode = 1;
} catch (error) {
    console.error('Dependency audit gate could not validate its evidence:', error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
}
