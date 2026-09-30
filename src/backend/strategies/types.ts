import type { Candle } from '../types/market.js';
import type { SignalDirection } from '../types/direction.js';

/**
 * What a strategy is, so that adding one does not mean editing the system.
 *
 * The request behind this file is to be able to add a rule without unpicking
 * the project, and that is a real structural constraint rather than a matter
 * of taste: every strategy added by editing the analysis service is a strategy
 * that cannot be tested on its own, cannot be compared against another, and
 * cannot be switched off without a code change in the middle of the signal
 * path.
 *
 * So the contract is deliberately small and deliberately strict. A module has
 * to state its **mechanism** — why it should make money at all — before it can
 * be registered, and the reason is not bureaucracy. A rule with no stated
 * mechanism is a curve with a name on it, and the name is the only part of it
 * that would survive a change of market. The mechanism is what tells a reader
 * whether a disappointing result means the market changed or the parameters
 * were fitted to noise, and those two are indistinguishable without it.
 *
 * The second rule is that a module is handed a **context that cannot contain
 * the future**. It receives the candles and is expected to look at the end of
 * them; it is not given an index or a way to ask for bar `i` in general. That
 * is what makes leakage structurally hard rather than a thing each strategy
 * author has to remember, and it is why the backtest and the running system
 * can share this contract and still mean the same thing by it.
 */

export type StrategyKey =
    | 'consensus-primary'
    | 'donchian-20'
    | 'donchian-trend-gated'
    | 'donchian-calm-gated'
    | 'volatility-trend';

export interface StrategyContext {
    /**
     * Oldest bar first, newest last, and complete: the last element is the bar
     * that just closed. There is no index parameter, so there is no way to
     * express "the value at bar 400" in a module that has 900 bars.
     */
    readonly candles: readonly Candle[];
    /** The price the analysis is being made for. Equals the last close. */
    readonly price: number;
}

export interface StrategyDecision {
    readonly direction: SignalDirection;
    /** [0, 1]. Meaningless when the direction is NEUTRAL. */
    readonly confidence: number;
    /** The Russian sentence a person reads, generated from the decision. */
    readonly reason: string;
    /**
     * True when the module has not yet seen enough bars to have an opinion.
     *
     * Reported separately from NEUTRAL on purpose. "Not enough history" and
     * "history says stand aside" are different answers with different
     * consequences, and a strategy that has to flatten them into one has to
     * decide which lie to tell.
     */
    readonly warm: boolean;
}

export interface StrategyModule {
    readonly key: StrategyKey;
    readonly name: string;
    /**
     * Why this should make money, in a sentence, written before it is run.
     *
     * Required by the registry rather than merely documented, because a
     * registry that accepts an empty string will receive one eventually.
     */
    readonly mechanism: string;
    /** Bars needed before the module has a real opinion. */
    readonly warmup: number;
    evaluate(context: StrategyContext): StrategyDecision;
}

export const NEUTRAL_DECISION = (reason: string, warm = false): StrategyDecision => ({
    direction: 'NEUTRAL',
    confidence: 0,
    reason,
    warm,
});
