import type { Candle } from '../types/market.js';

/**
 * The window that must not be looked at, declared before it exists.
 *
 * Everything measured in this project so far was measured on the same
 * BTCUSDT daily series: seven strategies were compared, one was recommended,
 * that recommendation was ablated, it was found to be a channel measured two
 * bars stale, it was corrected, a second rule was then chosen because the first
 * had turned out to lose money, and its parameters were walked looking for
 * robustness. Every one of those steps looked at the whole sample. The sample
 * is therefore exhausted as evidence, and no amount of further analysis of
 * 2018—2026 can make it un-exhausted.
 *
 * So the held-out window cannot be a slice of the history. It has to be data
 * that does not exist yet: the next fixed number of **live** bars, accumulated
 * after this file was written, with no rule tuned in the meantime. That is the
 * only window in reach that has not already been looked at, and it is the
 * reason a forward test is worth its months of waiting.
 *
 * The protocol is written down so that it cannot be quietly relaxed:
 *
 *   1. The window starts when this file is committed. Everything before that
 *      instant is development data and may be tuned against freely.
 *   2. A strategy is written down in `registerForEvaluation` **before** the
 *      window fills. Changing parameters afterwards is disqualifying, not
 *      unlucky — the result is then a description of the tuning, not of the rule.
 *   3. The window is read once, at the end, by `evaluateHoldout`, and every
 *      registered strategy is reported whether it passed or failed.
 *   4. One read. A second read after seeing the first is how a held-out window
 *      stops being one.
 *
 * The live database has a few hundred hourly bars against a daily history of
 * nearly three thousand, so the comparison has to happen on daily data. That
 * means accumulating hourly bars and resampling, which is a separate piece of
 * work; the commitment below is deliberately not dated by a bar count so that
 * the size of the job cannot quietly decide the deadline.
 */

export const HOLDOUT_COMMITTED_AT = Date.UTC(2026, 8, 27);
export const HOLDOUT_MINIMUM_BARS = 180;

export interface EvaluationCandidate {
    readonly key: string;
    /** Frozen at registration. Any later change invalidates the entry. */
    readonly fingerprint: string;
    readonly registeredAt: number;
    readonly note: string;
}

export interface HoldoutStatus {
    readonly committedAt: number;
    readonly minimumBars: number;
    readonly barsAvailable: number;
    readonly ready: boolean;
    readonly candidates: readonly EvaluationCandidate[];
    readonly message: string;
}

/**
 * Registers a rule to be judged on the window.
 *
 * The fingerprint is the whole mechanism: it is the rule's identity together
 * with its parameters, so a rule that is adjusted after registration no longer
 * matches its entry and is reported as having been changed rather than as
 * having failed. Those are very different sentences, and collapsing them would
 * make "we looked again and adjusted" indistinguishable from "we predicted and
 * were wrong".
 */
export function registerForEvaluation(
    key: string,
    fingerprint: string,
    note: string,
    at: number = Date.now(),
): EvaluationCandidate {
    return { key, fingerprint, registeredAt: at, note };
}

export function holdoutStatus(
    candles: readonly Candle[],
    candidates: readonly EvaluationCandidate[],
    now: number = Date.now(),
): HoldoutStatus {
    const available = candles.filter(
        (candle) => candle.timestamp >= HOLDOUT_COMMITTED_AT,
    ).length;
    const ready = available >= HOLDOUT_MINIMUM_BARS;

    return {
        committedAt: HOLDOUT_COMMITTED_AT,
        minimumBars: HOLDOUT_MINIMUM_BARS,
        barsAvailable: available,
        ready,
        candidates,
        message: ready
            ? `окно наполнено: ${available} баров, можно читать один раз`
            : `окно не наполнено: ${available} из ${HOLDOUT_MINIMUM_BARS}. ` +
              'До этого момента любая оценка по нему — выдумка.',
    };
}

/**
 * A single read.
 *
 * Named to be awkward to call twice, and to be the only way to get an answer.
 * It does not enforce the one-read rule — nothing here can, because reading a
 * number does not record that it was read — and the honest answer is that this
 * is a discipline enforced by a comment and a date, not by code. The checks
 * below are the parts a machine can hold: that enough bars exist, and that the
 * rule being reported is the rule that was registered.
 */
export function evaluateHoldout(
    status: HoldoutStatus,
    currentFingerprint: (key: string) => string,
): readonly { candidate: EvaluationCandidate; changed: boolean }[] {
    if (!status.ready) {
        throw new Error(status.message);
    }

    return status.candidates.map((candidate) => ({
        candidate,
        changed: currentFingerprint(candidate.key) !== candidate.fingerprint,
    }));
}
