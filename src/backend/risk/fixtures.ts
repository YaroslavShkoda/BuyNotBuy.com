import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MarginRules, RiskReport } from '../types/risk.js';
import type { RiskInput } from './schema.js';

/**
 * Shared test inputs for the risk contract suites.
 *
 * The baseline is the bundled CLI fixture: one JSON file is the single source
 * of the example market, so neither the CLI nor a suite carries a market
 * literal in code (the architecture lint is right to refuse those outside the
 * layers that name their subject on purpose). Every expected number in the
 * suites is derived on paper from the fixture values — qty 0.5, entry 40000,
 * current 41000, collateral 4000, mmr 0.01.
 */

const FIXTURE_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'linear-perp-manual.json',
);

const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as RiskInput;
const INVERSE_IDENTITY = JSON.parse(readFileSync(
    join(dirname(FIXTURE_PATH), 'inverse-usd.json'), 'utf8',
)) as Pick<RiskInput, 'ticker' | 'quoteCurrency'>;

export const LAST_BAR = FIXTURE.market.lastClosedBarTime;

/** A fresh copy of the bundled example input, for callers that want it as data. */
export function bundledFixtureInput(): RiskInput {
    return structuredClone(FIXTURE);
}

export function reviewedLinearRules(
    overrides: Partial<MarginRules> = {},
): MarginRules {
    const rules = FIXTURE.margin.rules;

    if (rules === null) {
        throw new Error('the bundled fixture must carry margin rules');
    }

    return structuredClone({ ...rules, ...overrides });
}

export function linearPerpInput(overrides: Partial<RiskInput> = {}): RiskInput {
    return { ...structuredClone(FIXTURE), ...overrides };
}

/** Inverse rules keep the USD contract size and collateral denomination explicit. */
export function reviewedInverseRules(overrides: Partial<MarginRules> = {}): MarginRules {
    return reviewedLinearRules({
        contractKind: 'inverse_perp',
        liquidationFormulaId: 'inverse_manual_v1',
        collateralCurrency: 'USD',
        ...overrides,
    });
}

/** USD inverse input; missing specification remains an explicit completeness question. */
export function inversePerpInput(overrides: Partial<RiskInput> = {}): RiskInput {
    const base = linearPerpInput();
    return {
        ...base,
        ...INVERSE_IDENTITY,
        contractKind: 'inverse_perp',
        atr: { ...base.atr, symbol: INVERSE_IDENTITY.ticker },
        margin: { mode: 'isolated', rules: reviewedInverseRules() },
        ...overrides,
    };
}

export function spotInput(overrides: Partial<RiskInput> = {}): RiskInput {
    return linearPerpInput({
        positionId: 'test-spot-001',
        contractKind: 'spot',
        collateralQuote: null,
        margin: { mode: null, rules: null },
        ...overrides,
    });
}

/** Collects every metric block of a report, wherever a section keeps them. */
export function allMetrics(report: RiskReport): RiskReport['positionRisk']['metrics'] {
    return [
        ...report.positionRisk.metrics,
        ...report.portfolioRisk.metrics,
        report.distances.percentDistance,
        report.distances.atrDistance,
    ];
}
