import type { Candle } from '../types/market.js';
import { calculateEMA } from './ema.js';

/**
 * The intermediate series indicators are built from, as named nodes in a graph.
 *
 * This exists for one reason: today no two indicators share a series, so
 * nothing is being saved. That is a fact about the present, not an argument
 * against doing it — the failure it prevents is an indicator being added that
 * recomputes the EMA-300 the next indicator already computed, at request time,
 * in a request that happens to need both. The alternative is that the saving
 * stays invisible until somebody notices a request taking twice as long as it
 * should and has to work out which of the nine calculations it is.
 *
 * The shape is a graph rather than a cache because the dependencies are real:
 * the signal line is an EMA of the MACD line, which is a difference of two
 * EMAs. Naming those four things makes the order of operations something the
 * graph decides and asserts, rather than something a reader has to reconstruct
 * from the inside of a ninety-line function.
 */

export interface SeriesContext {
    readonly candles: readonly Candle[];
    readonly closes: readonly number[];
}

export interface SeriesDefinition {
    /**
     * What this series is called.
     *
     * The name carries its parameters — `ema:26` — so that two different
     * periods are two different nodes and the graph cannot hand one to a
     * consumer that asked for the other.
     */
    readonly key: string;
    /** Series this one is built from, which must already be resolved. */
    readonly requires: readonly string[];
    readonly compute: (context: SeriesContext, resolved: ReadonlyMap<string, unknown>) => unknown;
}

/**
 * How many times each series was actually computed.
 *
 * Exposed because the claim this module makes — one computation per shared
 * dependency — is worth nothing unless it can be counted. A cache that silently
 * recomputed would look identical from the outside and cost the same as no
 * cache at all.
 */
export interface SeriesGraphStats {
    readonly computed: ReadonlyMap<string, number>;
    readonly reused: ReadonlyMap<string, number>;
}

export interface ResolvedSeries {
    /** Every requested series and everything it needed, by key. */
    readonly values: ReadonlyMap<string, unknown>;
    readonly stats: SeriesGraphStats;
}

export interface SeriesGraph {
    register(definition: SeriesDefinition): void;
    get(key: string): SeriesDefinition | undefined;
    list(): SeriesDefinition[];
    /** Resolves `keys` and their transitive requirements, computing each once. */
    resolve(keys: readonly string[], context: SeriesContext): ResolvedSeries;
    /**
     * The order the given keys would be computed in, without computing them.
     * A cycle shows up here as a throw rather than as a stack overflow during
     * a request.
     */
    plan(keys: readonly string[]): string[];
}

export function createSeriesGraph(): SeriesGraph {
    const definitions = new Map<string, SeriesDefinition>();

    return {
        register(definition) {
            if (definitions.has(definition.key)) {
                throw new Error(
                    `Series "${definition.key}" is already registered`,
                );
            }

            definitions.set(definition.key, definition);
        },

        get(key) {
            return definitions.get(key);
        },

        list() {
            return [...definitions.values()];
        },

        plan(keys) {
            const ordered: string[] = [];
            const done = new Set<string>();
            const visiting = new Set<string>();

            const visit = (key: string, path: readonly string[]): void => {
                if (done.has(key)) {
                    return;
                }

                if (visiting.has(key)) {
                    // The cycle is named in the error. A stack overflow says
                    // "Maximum call stack size exceeded", which is a fact about
                    // the runtime and not about the graph.
                    throw new Error(
                        `Series cycle: ${[...path, key].join(' -> ')}`,
                    );
                }

                const definition = definitions.get(key);

                if (definition === undefined) {
                    throw new Error(`Series "${key}" is not registered`);
                }

                visiting.add(key);

                for (const required of definition.requires) {
                    visit(required, [...path, key]);
                }

                visiting.delete(key);
                done.add(key);
                ordered.push(key);
            };

            for (const key of keys) {
                visit(key, []);
            }

            return ordered;
        },

        resolve(keys, context) {
            const order = this.plan(keys);
            const values = new Map<string, unknown>();
            const computed = new Map<string, number>();
            const reused = new Map<string, number>();

            for (const key of order) {
                const definition = definitions.get(key);
                const seen = computed.get(key) ?? 0;

                if (values.has(key) && seen > 0) {
                    reused.set(key, seen);
                    continue;
                }

                values.set(
                    key,
                    definition?.compute(context, values) ?? null,
                );
                computed.set(key, seen + 1);
            }

            return { values, stats: { computed, reused } };
        },
    };
}

/**
 * The EMA of the close series, as a node.
 *
 * Takes its period as an argument so the graph can hold several of them. The
 * key is `ema:<period>` rather than `ema`, because a graph that has one node
 * for "the EMA" has a node that cannot answer a request for two different
 * periods — and that is exactly the bug a graph is supposed to make
 * impossible.
 */
export function emaSeries(period: number): SeriesDefinition {
    return {
        key: `ema:${period}`,
        requires: [],
        compute: (context) => calculateEMA([...context.closes], period),
    };
}
