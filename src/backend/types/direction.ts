/**
 * The three things a rule can say about a market.
 *
 * **This was written out four times, and the duplication is what produced a
 * layering violation.** `strategies/types.ts` needed the vocabulary for
 * `StrategyDecision.direction` and imported it from `signals/signal.types.ts`,
 * which the layer table forbids — `strategies` is a leaf. That edge existed only
 * because no layer owns this. Meanwhile `indicators/performance` had the same
 * three literals written out inline in a type and again in a function
 * signature, and the database has the same list in four CHECK constraints.
 *
 * `types/` is where it goes because `types` is in UNIVERSAL: a word that every
 * layer needs and no layer owns cannot live inside any one of them. Putting it
 * in `signals/` was the accident, and the layering guard was right to object —
 * the guard was reporting a real file layout, not a false positive.
 *
 * **The name changed and the old one stayed.** `IndicatorSignal` is still
 * exported from `signals/signal.types.ts` as an alias, because renaming an
 * exported type is a breaking edit for every importer and this is a cleanup, not
 * a migration. `StrategyDecision.direction` reads better as a direction than as
 * an "indicator signal", which is what the leak was actually costing: a
 * strategy that has never heard of an indicator was importing a type named
 * after one.
 *
 * The SQL is left alone deliberately. `CHECK (signal IN ('LONG', 'SHORT',
 * 'NEUTRAL'))` is inside a migration string and is the schema of record;
 * generating it from this type would couple an old migration to today's source
 * file, and old results are not rewritten.
 */
export type SignalDirection = 'LONG' | 'SHORT' | 'NEUTRAL';
