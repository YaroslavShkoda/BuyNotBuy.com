import { beforeEach, describe, expect, it, vi } from 'vitest';

const evidenceFor = vi.fn();
const resolveActive = vi.fn();

vi.mock('../lifecycle/evidence.repository.js', () => ({
    createEvidenceReader: () => ({ evidenceFor }),
}));

vi.mock('../analysis/strategy-version.repository.js', () => ({
    getStrategyVersionRepository: () => ({ resolveActive }),
}));

const { createEvidenceGate } = await import('./promotion-gate.js');
const { DEFAULT_PROMOTION_CONFIG } = await import(
    '../lifecycle/promotion.config.js'
);

import type { RuleEvidence } from '../lifecycle/promotion.config.js';
import type { CandidateStage } from '../strategies/candidate.repository.js';

const DAY = 24 * 3_600_000;
/** 120 days after the evidence was first seen, so age and signals both pass. */
const NOW = 1_700_000_000_000 + 120 * DAY;
const FIRST_SEEN = NOW - 120 * DAY;

/**
 * Evidence that clears every condition, so each test can spoil exactly one.
 *
 * Built from the config's own thresholds rather than from round numbers, so the
 * fixture keeps meaning "enough" if the thresholds are ever revisited.
 */
function sufficient(overrides: Partial<RuleEvidence> = {}): RuleEvidence {
    const signals = DEFAULT_PROMOTION_CONFIG.shadowMinimumSignals + 10;
    const resolved = DEFAULT_PROMOTION_CONFIG.minimumSample + 10;

    return {
        signals,
        resolved,
        correct: resolved,
        incorrect: 0,
        flat: 0,
        // A comparison needs something on the other side. `evaluateShadow`
        // refuses an incumbent with no resolved signals on purpose, so a
        // fixture that cleared the gate without one was not clearing the gate.
        incumbentCorrect: 40,
        incumbentResolved: 40,
        firstSeenAt: FIRST_SEEN,
        lastSeenAt: NOW - DAY,
        ...overrides,
    };
}

const check = (to: CandidateStage, strategyVersionId: number | null) =>
    createEvidenceGate(() => NOW).check({ ruleId: 'r1', to, strategyVersionId });

describe('the evidence gate on the promotion ladder', () => {
    beforeEach(() => {
        evidenceFor.mockReset();
        resolveActive.mockReset();
        resolveActive.mockResolvedValue(null);
    });

    it('does not ask for history on any stage but approval', async () => {
        // The first rule a system ever writes has no shadow behind it. Asking
        // the question on the way in would refuse every new rule on the grounds
        // that it has never run, which is true and answers nothing.
        for (const to of [
            'candidate',
            'backtest',
            'walk-forward',
            'shadow',
            'retired',
        ] as const) {
            await expect(check(to, null)).resolves.toBeUndefined();
        }

        expect(evidenceFor).not.toHaveBeenCalled();
        expect(resolveActive).not.toHaveBeenCalled();
    });

    it('refuses approval that cannot say which configuration produced it', async () => {
        // A promotion nobody can re-derive later is the thing the ladder
        // exists to prevent, so this is refused before the evidence is even
        // read: there is nothing to read it for.
        await expect(check('approval', null)).rejects.toThrow(/cannot be approved/);

        expect(evidenceFor).not.toHaveBeenCalled();
    });

    it('refuses a shadow that has not run long enough, and says what is missing', async () => {
        evidenceFor.mockResolvedValue(
            sufficient({ firstSeenAt: NOW - 10 * DAY }),
        );

        const failure = await check('approval', 7).catch((error: Error) => error);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('r1');
        expect((failure as Error).message).toContain('Не хватает');
    });

    it('refuses a shadow with too few signals', async () => {
        evidenceFor.mockResolvedValue(
            sufficient({ signals: DEFAULT_PROMOTION_CONFIG.shadowMinimumSignals - 1 }),
        );

        await expect(check('approval', 7)).rejects.toThrow(/Не хватает/);
    });

    it('compares against the active configuration rather than an absolute bar', async () => {
        // The incumbent is the configuration currently in force, so a rule has
        // to beat what is already running — not an absolute number, and not
        // nothing. Passing the wrong id here would make every rule look better
        // than the one it is meant to replace.
        resolveActive.mockResolvedValue({ id: 99 });

        // The candidate is right twice in three; the rule already in force is
        // right every time. Matching the incumbent would pass, because
        // promotionMargin is negative — so the fixture has to be measurably
        // worse, or this test would be asserting that tying is enough.
        evidenceFor.mockResolvedValue(
            sufficient({
                resolved: 30,
                correct: 20,
                incorrect: 10,
                incumbentCorrect: 40,
                incumbentResolved: 40,
            }),
        );

        await expect(check('approval', 7)).rejects.toThrow(/Не хватает/);
        expect(evidenceFor).toHaveBeenCalledWith(
            7,
            DEFAULT_PROMOTION_CONFIG.evaluationHorizonBars,
            99,
        );
    });

    it('reads the horizon from the promotion config rather than assuming one', () => {
        // The horizon decides which distance a signal is judged at, and a
        // hard-coded number here would quietly stop matching the config the
        // rule was configured with, with the gate still reporting verdicts.
        expect(DEFAULT_PROMOTION_CONFIG.evaluationHorizonBars).toBeGreaterThan(0);
    });

    it('refuses a promotion with no incumbent to compare against', async () => {
        // With nothing in force, the reader reports an incumbent with no
        // resolved signals, and the gate refuses: a rule promoted against
        // nothing is a rule whose comparison was never made, and the promotion
        // record would then say it beat the incumbent. That is the project's
        // own reason, and the test exists to keep it from being relaxed
        // quietly into a free pass for the first rule.
        resolveActive.mockResolvedValue(null);
        evidenceFor.mockResolvedValue(
            sufficient({ incumbentCorrect: 0, incumbentResolved: 0 }),
        );

        await expect(check('approval', 7)).rejects.toThrow(/не с чем сравнивать/);
        expect(evidenceFor).toHaveBeenCalledWith(
            7,
            DEFAULT_PROMOTION_CONFIG.evaluationHorizonBars,
            null,
        );
    });

    it('lets a rule that has earned it through', async () => {
        // The control. A gate that refused unconditionally would satisfy every
        // refusal above and make the ladder a wall rather than a gate, which
        // is a failure that looks like safety.
        evidenceFor.mockResolvedValue(sufficient());

        await expect(check('approval', 7)).resolves.toBeUndefined();
    });
});
