export type ForwardHorizon = '1h' | '4h' | '24h';
/** Hours each horizon spans. Kept as data so a new one is a single entry. */
export const FORWARD_HORIZONS: Record<ForwardHorizon, number> = {
    '1h': 1,
    '4h': 4,
    '24h': 24,
};

export const FORWARD_HORIZON_NAMES = Object.keys(FORWARD_HORIZONS) as ForwardHorizon[];

export interface IndicatorVote {
    timestamp: number;
    symbol: string;
    /** Matches `IndicatorAnalysis.name`, so a vote is traceable to its reason. */
    indicator: string;
    signal: 'LONG' | 'SHORT' | 'NEUTRAL';
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
    signal: 'LONG' | 'SHORT' | 'NEUTRAL';
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
