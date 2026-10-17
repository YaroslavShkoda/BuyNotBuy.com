import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bundledFixtureInput } from '../risk/fixtures.js';
import { buildRiskReport } from '../risk/report.js';
import { RiskInputSchema } from '../risk/schema.js';

/**
 * Local CLI for the shadow risk report.
 *
 * Lives in the composition layer because its job is exactly that: reach the
 * pure builder in `risk/` from a command line, so the layer is reachable by
 * someone who runs it rather than reachable by declaration. Takes a path to a
 * JSON input; with no argument it reports on the bundled fixture input. It
 * reads one local file and nothing else: no network, no exchange, no
 * database, no environment secrets, and no write anywhere. A validation
 * failure names the offending field and exits non-zero.
 */

export interface CliIo {
    read(path: string): string;
    write(text: string): void;
    error(text: string): void;
}

export const defaultIo: CliIo = {
    read: (path) => readFileSync(path, 'utf8'),
    write: (text) => process.stdout.write(`${text}\n`),
    error: (text) => process.stderr.write(`${text}\n`),
};

/** Runs one report and returns the process exit code. */
export function runRiskReportCli(
    argv: readonly string[],
    io: CliIo = defaultIo,
): number {
    const requested = argv[2];

    if (requested === undefined) {
        io.write(JSON.stringify(buildRiskReport(bundledFixtureInput()), null, 2));

        return 0;
    }

    let raw: string;

    try {
        raw = io.read(requested);
    } catch (error) {
        io.error(`Cannot read input file ${requested}: ${String(error)}`);

        return 1;
    }

    let parsedJson: unknown;

    try {
        parsedJson = JSON.parse(raw) as unknown;
    } catch (error) {
        io.error(`Input is not valid JSON: ${String(error)}`);

        return 1;
    }

    const validated = RiskInputSchema.safeParse(parsedJson);

    if (!validated.success) {
        const issues = validated.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('\n');

        io.error(`Input rejected:\n${issues}`);

        return 1;
    }

    io.write(JSON.stringify(buildRiskReport(validated.data), null, 2));

    return 0;
}

function runningDirectly(): boolean {
    const entry = process.argv[1];

    if (entry === undefined) {
        return false;
    }

    try {
        const here = fileURLToPath(import.meta.url);
        const invoked = fileURLToPath(pathToFileURL(entry));

        return process.platform === 'win32'
            ? here.toLowerCase() === invoked.toLowerCase()
            : here === invoked;
    } catch {
        return false;
    }
}

if (runningDirectly()) {
    process.exitCode = runRiskReportCli(process.argv);
}
