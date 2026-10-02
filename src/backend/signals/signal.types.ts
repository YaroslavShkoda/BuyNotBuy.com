/**
 * The old home of the published signal's shapes, now an alias and nothing else.
 *
 * **The declarations moved to `types/analysis.ts`, and this file is what is left
 * of the old location.** The move is what closed invariant 13: the contract named
 * `SignalResult` and reached up into `signals/` for it, so the bottom layer
 * depended on two middle ones and the declaration that `types` reaches nothing
 * was false in the file it is about. A shared vocabulary belongs with the
 * contract — which is what `types/direction.ts` has always done for
 * `SIGNAL_DIRECTIONS`, and what this file's own comment used to argue for while
 * declaring the vocabulary from here.
 *
 * Kept as a re-export rather than deleted because fourteen modules read these
 * names from here and the alternative is a rename of an exported type — a
 * breaking edit for every importer, for a cleanup that is not a migration. The
 * names still resolve, the definitions have one home, and the graph shows
 * `signals → types` rather than the reverse.
 *
 * It is a single direction: nothing in `types` imports from this file, and
 * nothing should start to.
 */
export type {
    IndicatorAnalysis,
    IndicatorKey,
    IndicatorSignal,
    SignalResult,
} from '../types/analysis.js';
export { INDICATOR_KEYS } from '../types/analysis.js';

export type { SignalDirection } from '../types/direction.js';

