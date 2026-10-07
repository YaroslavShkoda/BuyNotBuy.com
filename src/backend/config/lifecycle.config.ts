import { z } from 'zod';
import { strategyProfile } from './strategy.profile.js';

/**
 * What a signal is doing right now.
 *
 * The states are the ones that answer a different question each. GENERATED is
 * "the panel agreed and nothing has been published yet". ACTIVE is "published
 * and still standing". UPDATED is "published, and the same direction now has
 * better evidence behind it". INVALIDATED is "the reasoning that produced it no
 * longer holds". EXPIRED is "it held for the configured number of bars and then
 * stopped". CLOSED is "finished, measured, out of the way".
 *
 * UPDATED is the one that is easy to get wrong. A signal that is republished
 * with a new price is not a new signal and not the same one either: measuring
 * it as a new signal double-counts it, and measuring it as unchanged hides the
 * fact that it was re-published at all.
 */
export const SignalStatusSchema = z.enum([
    'GENERATED',
    'ACTIVE',
    'UPDATED',
    'INVALIDATED',
    'EXPIRED',
    'CLOSED',
]);

export type SignalStatus = z.infer<typeof SignalStatusSchema>;

export const SignalDirectionSchema = z.enum(['LONG', 'SHORT']);
export type SignalDirection = z.infer<typeof SignalDirectionSchema>;

/**
 * The rules about when a signal moves, in one place.
 *
 * Configured rather than compiled in for the same reason every other threshold
 * in this system is: "how long before we give up on a signal" is a statement
 * about the instrument and the horizon, and a constant in the code is a
 * statement about whoever wrote it.
 */
const LifecycleConfigSchema = z
    .object({
        /**
         * How far price has to move before the same direction counts as
         * something new.
         *
         * A percentage rather than an absolute distance, so the same setting
         * means the same thing on BTC and on a cheap alt. Without it, a signal
         * is republished on every tick and the history becomes unreadable.
         */
        republishPriceMovePercent: z.coerce.number().min(0).max(100),
        /**
         * How much the confidence has to move for a republish to count as an
         * update rather than nothing at all.
         *
         * Confidence moves on every poll even when nothing has changed, so a
         * republish trigger of "anything" would produce a new row a minute.
         */
        republishConfidenceDelta: z.coerce.number().min(0).max(100),
        /**
         * How many closed bars a signal may stand before it expires.
         *
         * Counted in bars, not in wall time. A backend that was down for four
         * hours has not had four hours of signals expire; it has missed some
         * bars, and whether that is enough is a question about the bars it
         * actually saw.
         */
        expiryBars: z.coerce.number().int().positive(),
        /**
         * How many closed bars must pass before the same direction may be
         * published again.
         *
         * A real reversal is never blocked by this. Cooldown suppresses
         * re-entering a position the system just left — a market oscillating
         * around a line produces a stream of identical signals — and a
         * suppression rule that also blocked a genuine reversal would silence
         * the one event most worth recording.
         */
        cooldownBars: z.coerce.number().int().min(0),
        /**
         * How far against itself a signal has to move before it is invalidated
         * rather than left to expire.
         *
         * Stopping early is not the same as expiring: an invalidated signal
         * says the reasoning failed now, and an expired one says it ran out of
         * time while the reasoning was never contradicted.
         */
        invalidationPercent: z.coerce.number().min(0),
    })
    .refine(
        (config) => config.republishPriceMovePercent > 0,
        {
            // Zero means every poll is a new signal, and the history becomes a
            // stream of rows nobody can read. It is a plausible thing to type
            // and never a sensible setting.
            message:
                'A republish threshold of zero turns every poll into a new signal',
            path: ['republishPriceMovePercent'],
        },
    )
    .refine(
        (config) => config.cooldownBars < config.expiryBars,
        {
            // A cooldown at least as long as the expiry would leave a window
            // where the system is neither allowed to publish the same direction
            // again nor waiting for anything to resolve.
            message: 'Cooldown must be shorter than the expiry, or there is a gap where nothing can be published',
            path: ['cooldownBars'],
        },
    );

export type LifecycleConfig = z.infer<typeof LifecycleConfigSchema>;

export const lifecycleConfig: LifecycleConfig = LifecycleConfigSchema.parse(
    strategyProfile.lifecycle,
);

export const LifecycleConfigParser = LifecycleConfigSchema;
