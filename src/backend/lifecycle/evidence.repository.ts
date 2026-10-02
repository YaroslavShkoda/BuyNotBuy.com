import { query } from '../db/pool.js';

import type { RuleEvidence } from './promotion.config.js';

/**
 * Evidence read out of what the system actually did.
 *
 * **The counting is the whole content of this file, and one count in it is a
 * trap.** A signal that runs for 90 bars is measured at every configured
 * horizon, so one signal leaves seven rows in `signal_outcome` — seven real
 * rows, each with a real verdict. Summing them counts one signal seven times,
 * lets a rule clear a twenty-sample gate on three signals, and reports nothing
 * wrong at any point along the way: the SQL is correct, the numbers are
 * correct, and the *evidence* is seven times smaller than it looks. That is the
 * hardest kind of bug to notice, because nothing throws.
 *
 * So this counts one vote per signal, at one declared horizon. Where the
 * judgement came from, not from the row count.
 *
 * Signals come from `signal_state`, not from `signal_outcome`: a signal whose
 * horizon has not closed yet has no outcome row at all, and counting outcomes
 * would silently drop it — making "wait for more signals" report that enough
 * had already been produced, and turning a rule that needs time into a rule
 * that has had it.
 */
export interface EvidenceReader {
    /**
     * @param strategyVersionId the configuration under shadow
     * @param horizonBars the distance at which signals are judged
     * @param incumbentVersionId what the rule is being compared against, or
     *   null when the system has never resolved an active configuration
     * @param symbol the market to count, or null for every market under the
     *   version.
     *
     *   Still optional, and still worth passing. As of round 109 a fresh
     *   `strategy_version` belongs to one market, so for anything measured from
     *   then on the filter is redundant — but the rows already in the table span
     *   every asset, and those are exactly the ones a promotion would be judged
     *   on for a while. An unscoped read of them is a blend, and it would be read
     *   as the version's own record.
     *
     *   The redundancy is the point. A defence that stops working when its
     *   preconditions change is not a defence, and the precondition here is a
     *   table of historical rows nobody is going to rewrite.
     */
    evidenceFor(
        strategyVersionId: number,
        horizonBars: number,
        incumbentVersionId: number | null,
        symbol?: string,
    ): Promise<RuleEvidence>;
}

export function createEvidenceReader(): EvidenceReader {
    return {
        async evidenceFor(
            strategyVersionId: number,
            horizonBars: number,
            incumbentVersionId: number | null,
            symbol?: string,
        ): Promise<RuleEvidence> {
            // The market is threaded into **both** tallies. Passing it only to the
            // candidate would compare one market's candidate against every
            // market's incumbent, which is a blend in both halves rather than one.
            const counts = await tally(strategyVersionId, horizonBars, symbol);
            const incumbent =
                incumbentVersionId === null
                    ? { correct: 0, resolved: 0 }
                    : await tally(incumbentVersionId, horizonBars, symbol);

            return {
                signals: counts.signals,
                resolved: counts.resolved,
                correct: counts.correct,
                incorrect: counts.incorrect,
                flat: counts.flat,
                incumbentCorrect: incumbent.correct,
                incumbentResolved: incumbent.resolved,
                firstSeenAt: counts.firstSeenAt,
                lastSeenAt: counts.lastSeenAt,
            };
        },
    };
}

interface Tally {
    readonly signals: number;
    readonly resolved: number;
    readonly correct: number;
    readonly incorrect: number;
    readonly flat: number;
    readonly firstSeenAt: number;
    readonly lastSeenAt: number;
}

/**
 * Verdicts that mean "not an answer yet".
 *
 * Matched as a set, the way `outcome.repository` matches it, rather than by
 * assuming the complement is resolved: a new verdict would otherwise be
 * counted as evidence of correctness by arithmetic accident.
 */
const UNRESOLVED = "('unknown', 'expired')";

/**
 * A version with nothing measured yet still has to produce evidence — all
 * zeros and a first-seen time of now.
 *
 * Zero is the honest answer. A first-seen time of zero would be the worst kind
 * of lie: the gate reads `now - firstSeenAt` as an age, so a rule that has
 * never produced a signal would appear to have been in shadow for fifty years
 * and would sail past the window on the strength of having no history at all.
 */
async function tally(
    strategyVersionId: number,
    horizonBars: number,
    symbol?: string,
): Promise<Tally> {
    const { rows } = await query<Record<string, string | number>>(
        `WITH produced AS (
             SELECT s.id, s.created_at
               FROM signal_state s
               JOIN signal_snapshot p ON p.id = s.snapshot_id
              WHERE p.strategy_version_id = $1
                AND ($4::text IS NULL OR s.symbol = $4)
         ),
         judged AS (
             SELECT o.signal_state_id, o.verdict
               FROM signal_outcome o
              WHERE o.strategy_version_id = $1
                AND o.horizon_bars = $2
                AND o.verdict NOT IN ${UNRESOLVED}
                AND ($4::text IS NULL OR o.symbol = $4)
         )
         SELECT
             (SELECT count(*) FROM produced)::bigint AS signals,
             (SELECT count(*) FROM judged)::bigint AS resolved,
             (SELECT count(*) FROM judged WHERE verdict = 'correct')::bigint AS correct,
             (SELECT count(*) FROM judged WHERE verdict = 'incorrect')::bigint AS incorrect,
             (SELECT count(*) FROM judged WHERE verdict = 'flat')::bigint AS flat,
             COALESCE((SELECT min(created_at) FROM produced), $3)::bigint AS first_seen_at,
             COALESCE((SELECT max(created_at) FROM produced), $3)::bigint AS last_seen_at`,
        [strategyVersionId, horizonBars, Date.now(), symbol ?? null],
    );

    const row = rows[0] ?? {};

    return {
        signals: Number(row['signals'] ?? 0),
        resolved: Number(row['resolved'] ?? 0),
        correct: Number(row['correct'] ?? 0),
        incorrect: Number(row['incorrect'] ?? 0),
        flat: Number(row['flat'] ?? 0),
        firstSeenAt: Number(row['first_seen_at'] ?? Date.now()),
        lastSeenAt: Number(row['last_seen_at'] ?? Date.now()),
    };
}
