import { describe, expect, it } from 'vitest';

import { strategySetFingerprint } from './strategy-fingerprint.js';
import { STRATEGY_FACTORIES } from './registry.js';

/**
 * The fingerprint exists so that a number can be traced to the configuration
 * that produced it. It therefore has to move when a rule is added — and the
 * failure is silent, because nothing crashes and no signal changes: the
 * signals are simply filed under a configuration that never had the new rule
 * in it.
 */

describe('the configuration remembers what was installed', () => {
    it('lists every rule the registry can build', () => {
        const { installed } = strategySetFingerprint();

        for (const key of Object.keys(STRATEGY_FACTORIES)) {
            expect(installed).toContain(key);
        }

        expect(installed).toContain('consensus-primary');
    });

    it('has no rule the registry cannot build', () => {
        // The other direction matters as much: a name that no longer resolves
        // is a configuration claiming a rule that cannot run.
        const { installed } = strategySetFingerprint();

        for (const key of installed) {
            if (key !== 'consensus-primary') {
                expect(Object.keys(STRATEGY_FACTORIES)).toContain(key);
            }
        }
    });

    it('is stable for a given set of rules, so a snapshot can be matched to it', () => {
        expect(strategySetFingerprint()).toEqual(strategySetFingerprint());
    });

    it('orders the list, so two machines that installed the same rules agree', () => {
        // Without an order, the same set of rules could hash two ways on two
        // hosts and every cross-machine comparison of a number would be void.
        const { installed } = strategySetFingerprint();

        expect(installed).toEqual([...installed].sort((a, b) => a.localeCompare(b)));
    });
});
