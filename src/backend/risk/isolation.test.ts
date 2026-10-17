import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRiskReportCli } from '../research/risk-report.cli.js';
import { NetworkAccessError } from '../test-support/no-network.js';
import { linearPerpInput } from './fixtures.js';
import { buildRiskReport } from './report.js';

/**
 * Isolation, checked rather than promised.
 *
 * The layer table already forbids the edges; these tests make the shadow
 * module's own discipline visible: no trading import anywhere in `risk/`, a
 * builder that neither mutates its input nor talks to anything, and a CLI
 * that reads one local file and nothing else. The no-network guard is global
 * (see `vitest.config.mts`); the guard assertion proves it is active for this
 * suite too.
 */

const riskDir = join(process.cwd(), 'src', 'backend', 'risk');

const RISK_SOURCES = readdirSync(riskDir).filter(
    (entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'),
);

const FORBIDDEN_LAYERS = [
    'signals',
    'strategies',
    'analysis',
    'lifecycle',
    'outcomes',
    'performance',
    'api',
    'db',
    'history',
    'services',
    'market',
    'indicators',
    'backtest',
];

describe('the risk module stays out of the trading path', () => {
    it('imports nothing from a trading or persistence layer', () => {
        const offenders: string[] = [];

        for (const file of RISK_SOURCES) {
            const text = readFileSync(join(riskDir, file), 'utf8');

            for (const layer of FORBIDDEN_LAYERS) {
                const pattern = new RegExp(
                    `from\\s+['"](?:[^'"]*/)?${layer}/[^'"]*['"]`,
                );

                if (pattern.test(text)) {
                    offenders.push(`${file} -> ${layer}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });
});

describe('the builder is pure', () => {
    it('produces the same report twice without mutating a frozen input', () => {
        const input = linearPerpInput();

        Object.freeze(input);
        Object.freeze(input.market.candles);
        Object.freeze(input.market);
        Object.freeze(input.costs);
        Object.freeze(input.dataQuality);

        const first = JSON.stringify(buildRiskReport(input));
        const second = JSON.stringify(buildRiskReport(input));

        expect(first).toBe(second);
    });
});

describe('the CLI', () => {
    const fixturePath = join(riskDir, 'fixtures', 'linear-perp-manual.json');

    function io() {
        const out: string[] = [];
        const err: string[] = [];

        return {
            out,
            err,
            io: {
                read: (path: string) => readFileSync(path, 'utf8'),
                write: (text: string) => {
                    out.push(text);
                },
                error: (text: string) => {
                    err.push(text);
                },
            },
        };
    }

    it('prints a report for a valid input file and exits zero', () => {
        const { out, err, io: captured } = io();
        const code = runRiskReportCli(['node', 'risk-report.cli.ts', fixturePath], captured);

        expect(code).toBe(0);
        expect(err).toEqual([]);

        const report = JSON.parse(out.join('')) as { schemaVersion: string };

        expect(report.schemaVersion).toBe('risk-report/1');
    });

    it('uses the bundled fixture when no input is given', () => {
        const { out, io: captured } = io();
        const code = runRiskReportCli(['node', 'risk-report.cli.ts'], captured);

        expect(code).toBe(0);
        expect(JSON.parse(out.join('')).inputs.contractKind).toBe('linear_perp');
    });

    it('fails on a missing file', () => {
        const { err, io: captured } = io();
        const code = runRiskReportCli(
            ['node', 'risk-report.cli.ts', join(riskDir, 'no-such-file.json')],
            captured,
        );

        expect(code).toBe(1);
        expect(err.join('')).toContain('Cannot read input file');
    });

    it('fails on invalid JSON', () => {
        const { err, io: captured } = io();
        const code = runRiskReportCli(
            ['node', 'risk-report.cli.ts', fixturePath],
            { ...captured, read: () => '{ not json' },
        );

        expect(code).toBe(1);
        expect(err.join('')).toContain('not valid JSON');
    });

    it('names the rejected field on an invalid input', () => {
        const { err, io: captured } = io();
        const broken = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;

        delete broken.positionId;

        const code = runRiskReportCli(['node', 'risk-report.cli.ts', fixturePath], {
            ...captured,
            read: () => JSON.stringify(broken),
        });

        expect(code).toBe(1);
        expect(err.join('')).toContain('positionId');
    });
});

describe('the no-network guard is active for this suite', () => {
    it('refuses a fetch instead of reaching out', async () => {
        await expect(fetch('http://example.invalid/')).rejects.toBeInstanceOf(
            NetworkAccessError,
        );
    });
});
