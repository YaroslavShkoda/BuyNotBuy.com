interface Options {
    start: number;
    now: number;
    intervalMs: number;
    minimumIndependentBlocks: number;
    registeredAt?: number;
}

/** Eligibility only. Sample size cannot establish independence or calibration. */
export function assessProspectiveReadiness(timestamps: readonly number[], options: Options) {
    for (const value of Object.values(options)) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid prospective window');
    }
    let previous = -Infinity;
    let eligibleBars = 0;
    for (const timestamp of timestamps) {
        if (!Number.isSafeInteger(timestamp) || timestamp <= previous) throw new Error('timestamps must be safe and strictly ordered');
        previous = timestamp;
        if (options.registeredAt !== undefined
            && timestamp >= Math.max(options.start, options.registeredAt)
            && timestamp <= options.now - options.intervalMs) eligibleBars += 1;
    }
    return {
        eligibleBars,
        minimumIndependentBlocks: options.minimumIndependentBlocks,
        calibration: eligibleBars === 0 || eligibleBars >= options.minimumIndependentBlocks
            ? 'not_calibrated' as const : 'insufficient' as const,
        outcome: 'INCONCLUSIVE' as const,
        reason: options.registeredAt === undefined ? 'registration_not_accepted'
            : eligibleBars === 0 ? 'no_closed_prospective_bars'
            : eligibleBars < options.minimumIndependentBlocks ? 'too_few_even_before_dependence_adjustment'
                : 'independence_and_calibration_not_validated',
    };
}
