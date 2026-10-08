import type { StrategyContext, StrategyDecision, StrategyModule } from './types.js';
import { NEUTRAL_DECISION } from './types.js';

/**
 * The existing consensus, wearing the strategy interface.
 *
 * This is an adapter and nothing else. The arithmetic stays where it is — in
 * `signals/consensus.ts`, tested by the tests that have always tested it — and
 * this module only carries the result across the boundary so that a fallback
 * has something to be a fallback *to*.
 *
 * It exists because the alternative is worse. A system where only the fallback
 * is a strategy module and the primary is not has a registry that is lying:
 * `getPrimary()` would return something the rest of the code cannot treat the
 * same way as the others, and the first person to add a second strategy would
 * find that "which strategy produced this signal" has no uniform answer. The
 * wrapper costs a function call and makes the question answerable.
 *
 * The indicator computation is injected rather than imported, because the
 * consensus is defined over the indicator readings and this module is
 * deliberately not handed the indicator service. Recomputing them here would
 * give two versions of every reading, and they would drift.
 */
interface ConsensusPrimaryConfig {
    /** How many trailing closes the EMA confirmation reads. */
    readonly emaConfirmBars: number;
}

export type ConsensusComputation = (
    price: number,
    emaCloses: number[],
) => StrategyDecision;

export function createConsensusPrimary(
    compute: ConsensusComputation,
    config: ConsensusPrimaryConfig,
): StrategyModule {
    const required = config.emaConfirmBars + 1;

    return {
        key: 'consensus-primary',
        name: 'Консенсус индикаторов',
        mechanism:
            'Three indicators vote independently and the panel publishes only ' +
            'when enough of them agree and agree with conviction. Mechanism: ' +
            'agreement across independent measurements reduces the chance that ' +
            'one reading is simply wrong.',
        warmup: required,

        evaluate(context: StrategyContext): StrategyDecision {
            // Before the call, not after. Computing a vote from fewer closes
            // than the confirmation needs would silently produce a shorter
            // confirmation than the one every other signal was produced with,
            // and a shorter confirmation is a more trigger-happy one.
            if (context.candles.length < required) {
                return NEUTRAL_DECISION(
                    `Недостаточно закрытий для подтверждения EMA: нужно ${required}, есть ${context.candles.length}`,
                    true,
                );
            }

            return compute(
                context.price,
                context.candles
                    .slice(-required)
                    .map((candle) => candle.close),
            );
        },
    };
}
