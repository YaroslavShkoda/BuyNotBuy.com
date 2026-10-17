import type {
    MetricBlock,
    RiskNoticeCode,
    RiskStatus,
    RiskUnit,
} from '../types/risk.js';

/**
 * Status arithmetic for the shadow risk report.
 *
 * The report's trust level is derived from its parts, never asserted. The
 * severity order is fixed and `not_applicable` sits at zero on purpose: "this
 * metric does not exist for this instrument" must never drag down sections
 * that do exist, which is exactly what an operator comparing a spot input
 * with a perpetual one needs to hold.
 */

const SEVERITY: Readonly<Record<RiskStatus, number>> = {
    valid: 0,
    not_applicable: 0,
    degraded: 1,
    insufficient_data: 2,
    calculation_error: 3,
};

/**
 * The worst status in the list.
 *
 * Severity decides everything except the zero tier, where `valid` and
 * `not_applicable` are equal: there the report says `valid` when anything at
 * all was computed — `not_applicable` sections must not rename a working
 * report — and `not_applicable` only when that is the whole story.
 */
export function worstStatus(statuses: readonly RiskStatus[]): RiskStatus {
    let worst: RiskStatus = 'valid';

    for (const status of statuses) {
        if (SEVERITY[status] > SEVERITY[worst]) {
            worst = status;
        }
    }

    if (SEVERITY[worst] === 0) {
        if (statuses.includes('valid')) {
            return 'valid';
        }

        return statuses.includes('not_applicable') ? 'not_applicable' : 'valid';
    }

    return worst;
}

/**
 * Builds a metric block.
 *
 * The one invariant the report promises is enforced here rather than hoped
 * for: a `valid` metric has a finite number. `degraded` may carry `null` when the
 * limitation is the absence of an input (unknown funding), and every
 * non-`valid` status must say why through a reason code.
 */
export function metric(
    metricKey: string,
    unit: RiskUnit,
    value: number | null,
    status: RiskStatus,
    reasonCode: RiskNoticeCode | null = null,
): MetricBlock {
    if (value !== null && !Number.isFinite(value)) {
        return {
            metricKey,
            value: null,
            unit,
            status: 'calculation_error',
            reasonCode: 'CALCULATION_OVERFLOW',
        };
    }

    if (status === 'valid' && value === null) {
        throw new Error(`metric ${metricKey} is valid but has no value`);
    }

    if (status !== 'valid' && reasonCode === null) {
        throw new Error(`metric ${metricKey} has status ${status} without a reason`);
    }

    return { metricKey, value, unit, status, reasonCode };
}

/** Calculation failures take priority over unrelated unavailable metrics. */
export function sectionReason(
    metrics: readonly MetricBlock[],
): RiskNoticeCode | null {
    const failed = metrics.find((entry) => entry.status === 'calculation_error');
    if (failed !== undefined) {
        return failed.reasonCode;
    }

    for (const entry of metrics) {
        if (entry.reasonCode !== null) {
            return entry.reasonCode;
        }
    }

    return null;
}
