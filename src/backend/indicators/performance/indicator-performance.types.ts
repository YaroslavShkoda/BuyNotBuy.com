import type { SignalDirection } from '../../types/direction.js';

/**
 * The horizons a forward return can be measured over.
 *
 * **A tuple, because the list used to exist only as a cast.** `FORWARD_HORIZON_NAMES`
 * was `Object.keys(FORWARD_HORIZONS) as ForwardHorizon[]` — a `string[]` wearing
 * a horizon's name, with the cast standing in for the proof. Everything that
 * iterates horizons, builds a SQL column per horizon or settles by name took
 * that array on trust, and a fourth horizon added to the record without the cast
 * being revisited would have produced a `string` where the code expected a
 * horizon. The cast was not needed because the record was keyed; it was there
 * because the vocabulary had no form of its own to read at runtime.
 *
 * `FORWARD_HORIZONS` still enumerates its own keys — a record of hours cannot be
 * built from a bare list — but the list is declared here now, and the type is
 * derived from it rather than written beside it.
 */
export const FORWARD_HORIZON_KEYS = ['1h', '4h', '24h'] as const;

export type ForwardHorizon = (typeof FORWARD_HORIZON_KEYS)[number];

/** Hours each horizon spans. Kept as data so a new one is a single entry. */
export const FORWARD_HORIZONS: Record<ForwardHorizon, number> = {
    '1h': 1,
    '4h': 4,
    '24h': 24,
};

export const FORWARD_HORIZON_NAMES: readonly ForwardHorizon[] = [
    ...FORWARD_HORIZON_KEYS,
];

export interface IndicatorVote {
    timestamp: number;
    symbol: string;
    /** Matches `IndicatorAnalysis.name`, so a vote is traceable to its reason. */
    indicator: string;
    signal: SignalDirection;
    weight: number;
    price: number;    /**
     * Return the price made after the vote, as a fraction: 0.01 is +1%.
     *
     * Signed in the direction of the vote, so a correct LONG and a correct
     * SHORT both come out positive and can be averaged together. `null` until
     * the horizon has actually elapsed — a forward return is a promise about
     * the future, and filling it with zero would make an unresolved vote look
     * like a flat one.
     */
    fwdReturns: Partial<Record<ForwardHorizon, number>>;
}

/** A vote still waiting for one or more horizons to close. */
export interface UnsettledVote {
    symbol: string;
    timestamp: number;
    /**
     * Which indicator cast it.
     *
     * Kept per indicator rather than collapsed per hour on purpose: two
     * indicators disagreeing on the same reading must be settled against
     * their own directions, or one of them would inherit the other's verdict
     * and the whole comparison would be circular.
     */
    indicator: string;
    price: number;
    signal: SignalDirection;
    /** Horizons that have no value yet. */
    pending: ForwardHorizon[];
}

/** A single write: which vote, and which horizons it can finally answer. */
export interface SettleUpdate {
    timestamp: number;
    indicator: string;
    returns: Partial<Record<ForwardHorizon, number>>;
}

export interface IndicatorPerformance {
    indicator: string;
    horizon: ForwardHorizon;
    /** Votes that had an opinion and whose horizon has closed. */
    samples: number;
    /** Share of those whose direction was right, after costs. */
    hitRate: number;
    /** Mean signed return per vote, after costs. */
    averageReturn: number;
    /** Largest and smallest single result, for a sense of the spread. */
    best: number;
    worst: number;
}

export interface IndicatorLogger {
    warn(context: Record<string, unknown>, message: string): void;
    info?(context: Record<string, unknown>, message: string): void;
}

export type { IndicatorVoteRepository } from './indicator-vote.repository.js';
