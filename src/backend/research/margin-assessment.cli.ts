import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildMarginAssessment, prepareAssessmentContext } from '../risk/stage3/assessment-builder.js';
import { prepareMarginInputJson } from '../risk/stage3/canonicalization.js';
import { type CliIo, defaultIo } from './risk-report.cli.js';

/**
 * Local read-only CLI for the margin-assessment/1 builder.
 *
 * Composition layer, same shape as the shadow risk report command: it reaches
 * the pure stage-3 assembler from a command line and nothing else. Takes one
 * path to a JSON document holding a manual or test snapshot-plus-policy
 * envelope; there is no bundled default, because an assessment is always bound
 * to an explicit, attributable input. It reads one local file and nothing
 * else: no network, no exchange, no database, no environment secrets, and no
 * write anywhere. Scope gating and validation happened upstream, so a refusal
 * names the offending field, the unsupported scope, or the JSON fault and
 * exits non-zero; a supported input prints the margin-assessment/1 document
 * and exits zero.
 */

export function runMarginAssessmentCli(
    argv: readonly string[],
    io: CliIo = defaultIo,
): number {
    const requested = argv[2];

    if (requested === undefined) {
        io.error('Usage: margin-assessment.cli.ts <snapshot-policy.json>');
        io.error('Input: one JSON object { snapshot, policy } for generic-linear-isolated@1.');
        io.error('Read-only: the file is read, one assessment is printed, nothing is written.');

        return 1;
    }

    let raw: string;

    try {
        raw = io.read(requested);
    } catch (error) {
        io.error(`Cannot read input file ${requested}: ${String(error)}`);

        return 1;
    }

    const prepared = prepareMarginInputJson(raw);

    if (prepared.kind === 'invalid_json') {
        io.error(`Input rejected: ${prepared.code}`);

        return 1;
    }

    if (prepared.kind === 'invalid') {
        const issues = prepared.issues
            .map((issue) => {
                const rule = issue.rule === null ? '' : ` [${issue.rule}]`;
                const unknown = issue.unknownKeys.length === 0
                    ? ''
                    : ` unknown: ${issue.unknownKeys.join(', ')}`;

                return `${issue.path.join('.') || '(root)'}: ${issue.code}${rule}${unknown}`;
            })
            .join('\n');

        io.error(`Input rejected:\n${issues}`);

        return 1;
    }

    if (prepared.kind === 'unsupported') {
        io.error(
            `Scope not supported: ${prepared.scope.modelId}@${prepared.scope.modelVersion}, ` +
            `${prepared.scope.contractKind}/${prepared.scope.marginMode}\n` +
            `  ${prepared.reasons.join(', ')}`,
        );

        return 1;
    }

    const context = prepareAssessmentContext();

    if (!context.ok) {
        io.error(`Assessment context refused: ${context.error.code}`);

        return 1;
    }

    const assessment = buildMarginAssessment(prepared.handle, context.value);

    if (!assessment.ok) {
        io.error(`Assessment refused: ${assessment.error.code}`);

        return 1;
    }

    io.write(JSON.stringify(assessment.value, null, 2));

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
    process.exitCode = runMarginAssessmentCli(process.argv);
}
