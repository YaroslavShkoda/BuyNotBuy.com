/**
 * A bounded, first-in-first-out holding area for records that could not be
 * written.
 *
 * Shared by the two write paths that exist to be fail-open — signal history and
 * per-indicator votes — because the reason for buffering is the same in both:
 * a persistence failure must never propagate into the market analysis path, and
 * dropping the record outright leaves a hole that a later summary reads as
 * "nothing changed", which is the one conclusion missing data must not be
 * allowed to produce.
 *
 * Bounded on purpose: a long outage must not become unbounded memory growth,
 * and the oldest entries are the least useful to keep.
 *
 * **It lives here rather than in `history/`, and it never did belong there.**
 * Its own first paragraph says it is shared by two write paths, one of which is
 * in `indicators/`, and `indicators` is declared a leaf that may import
 * nothing. While the file sat in `history/`, that made the second write path
 * commit a layering violation every time it used the thing built to help it:
 * the shared utility was misfiled as one consumer's domain, and the guard was
 * pointing at a true statement about the wrong file.
 *
 * `observability` is where the layer table puts things everything may count
 * through, and that is what this is: a failure absorbed on purpose so it can be
 * counted later and drained. `BacklogState` came with it, because it is the two
 * counters below under different names — it was declared in
 * `history/signal-history.service.ts` and used by `indicators/` for a shape
 * that describes a buffer, so a second layer was reaching into a service to
 * name the state of an object it did not own.
 */
export interface BoundedWriteBuffer<T> {
    push(entry: T): void;
    /** Oldest first, removed from the buffer as they are returned. */
    drain(): T[];
    readonly size: number;
    /** Entries dropped because the buffer was full, over the buffer's lifetime. */
    readonly droppedCount: number;
    /**
     * The same two counts, split by market.
     *
     * **The buffer is one queue, but what an operator needs is per market.** With
     * `MARKET_SYMBOLS` naming a second market, a total says only that *someone*
     * is losing records — and the failure it has to diagnose is per market by
     * construction, since one market's series is written by one configured venue.
     *
     * A total also hides which market a drop belonged to, and that attribution
     * matters more than the count: a full buffer drops the **oldest** entry, so a
     * market in a long outage can evict a healthy market's records, and the
     * healthy market is the one whose series will show a hole nobody wrote about.
     * Splitting the counters is what makes that visible. It does not stop it —
     * the ceiling stays one ceiling for the process, and per-market buffers would
     * multiply the memory bound by the number of markets, which is the trade this
     * is deliberately not making.
     *
     * This is the buffer's half only: the durable lane counts its own queue and
     * its own losses per market, and `mergeBacklogStates` below is where the
     * two halves become the one record an operator reads.
     */
    readonly byMarket: MemoryBacklogStateByMarket;
    clear(): void;
}

interface BoundedWriteBufferOptions<T> {
    /** Hard ceiling on buffered entries; oldest are dropped past this. */
    maxSize: number;
    /** Which record this buffer holds, for the operator reading a counter. */
    label: string;
    /**
     * The market an entry belongs to, for the per-market counters.
     *
     * Required rather than optional: a buffer that could not attribute its drops
     * would make `byMarket` silently empty, and an empty object reads exactly
     * like "no market has ever dropped anything". Failing to compile is the
     * better outcome, and both call sites have a symbol in hand.
     */
    marketOf: (entry: T) => string;
}

/**
 * What an operator reads off a backlog.
 *
 * Declared beside the buffer rather than in the service that first needed it,
 * because it is the buffer's own `size` and `droppedCount` under the names the
 * health endpoint has always used. The two counter names are not the same on
 * purpose: `buffered` is now, `dropped` is since the process started, and a
 * reader is meant to be able to tell that. `spooled` joined them when the
 * durable lane did: the memory bound and the disk bound are two ceilings over
 * one series, and a reader who sees only the memory count would call a long
 * outage survived when the entries are in fact sitting in a file.
 */
export interface BacklogState {
    /** Entries held for a retry in memory. */
    buffered: number;
    /** Entries lost to an overfull buffer, an overfull spool, or a torn line, since the process started. */
    dropped: number;
    /**
     * Entries held on disk for a retry, on top of the memory bound.
     *
     * Declared here rather than left to each writer's return type because the
     * three backlogs grew the third counter together, and a shape that said
     * "two numbers" would have had every reader invent its own name for the
     * third — or, likelier, keep reading two and miss the third entirely.
     */
    spooled: number;
}

/**
 * The buffer's own half of a backlog, before the spool's half is merged in.
 *
 * Split from `BacklogState` rather than reused, because the buffer can only
 * speak for what it holds and what it has dropped; the third counter belongs
 * to the durable lane, and a buffer reporting `spooled: 0` would be a lie
 * wearing the right type.
 */
interface MemoryBacklogState {
    buffered: number;
    dropped: number;
}

/** The per-market split of a buffer, keyed by market. */
export type MemoryBacklogStateByMarket = Readonly<Record<string, MemoryBacklogState>>;

/** The per-market split of a merged backlog, keyed by market. */
export type BacklogStateByMarket = Readonly<Record<string, BacklogState>>;

/**
 * Merges the buffer's per-market counts with the spool's into the operator
 * shape, over the union of the two key sets — a market that has only ever
 * lost memory entries and a market that has only ever been spooled must both
 * read as themselves, not as absent.
 */
export function mergeBacklogStates(
    memory: MemoryBacklogStateByMarket,
    spool: Readonly<Record<string, { spooled: number; dropped: number }>>,
): BacklogStateByMarket {
    const markets = new Set<string>([...Object.keys(memory), ...Object.keys(spool)]);

    const merged: Record<string, BacklogState> = {};

    for (const market of [...markets].sort()) {
        const memoryState = memory[market] ?? { buffered: 0, dropped: 0 };
        const spoolState = spool[market] ?? { spooled: 0, dropped: 0 };

        merged[market] = {
            buffered: memoryState.buffered,
            dropped: memoryState.dropped + spoolState.dropped,
            spooled: spoolState.spooled,
        };
    }

    return merged;
}

export function createBoundedWriteBuffer<T>(
    options: BoundedWriteBufferOptions<T>,
): BoundedWriteBuffer<T> {
    const entries: T[] = [];

    let dropped = 0;

    // Two tallies rather than a recount of the queue, and deliberately:
    // `drained` exists precisely because a drop is not observable any other way.
    // A drop happens when an entry is *evicted*, so by the time anyone asks, the
    // entry is gone — there is nothing left to count it from. And it is a drop,
    // not a success, so it must not survive a drain as a retry either.
    const droppedByMarket = new Map<string, number>();

    return {
        push(entry: T): void {
            entries.push(entry);

            while (entries.length > options.maxSize) {
                const evicted = entries.shift();

                dropped += 1;

                if (evicted !== undefined) {
                    const market = options.marketOf(evicted);

                    droppedByMarket.set(market, (droppedByMarket.get(market) ?? 0) + 1);
                }
            }
        },

        drain(): T[] {
            return entries.splice(0, entries.length);
        },

        get size(): number {
            return entries.length;
        },

        get droppedCount(): number {
            return dropped;
        },

        get byMarket(): MemoryBacklogStateByMarket {
            // Counted from what is *in* the queue, not remembered: a market that
            // drained cleanly must read as 0 buffered, and a remembered count
            // would have to be decremented on every drain path to stay honest.
            const buffered = new Map<string, number>();

            for (const entry of entries) {
                const market = options.marketOf(entry);

                buffered.set(market, (buffered.get(market) ?? 0) + 1);
            }

            const markets = new Set<string>([
                ...buffered.keys(),
                ...droppedByMarket.keys(),
            ]);

            const state: Record<string, MemoryBacklogState> = {};

            for (const market of [...markets].sort()) {
                state[market] = {
                    buffered: buffered.get(market) ?? 0,
                    dropped: droppedByMarket.get(market) ?? 0,
                };
            }

            return state;
        },

        clear(): void {
            entries.length = 0;
        },
    };
}

/**
 * Runs at most one flush at a time, and hands concurrent callers the same run.
 *
 * Two flushes racing each other would drain the buffer into local variables and
 * then both write the same entries, and — worse — a push arriving between one
 * drain and its failure re-queue would be replayed against a repository that
 * had already accepted it. The write is idempotent, so the duplicate is
 * harmless, but the interleaving is not something to reason about at three in
 * the morning.
 */
interface FlushGuard {
    /** Runs the given flush, or joins the one already running. */
    (flush: () => Promise<number>): Promise<number>;
}

export function createFlushGuard(): FlushGuard {
    let inFlight: Promise<number> | null = null;

    return (flush: () => Promise<number>): Promise<number> => {
        if (inFlight !== null) {
            return inFlight;
        }

        inFlight = flush().finally(() => {
            inFlight = null;
        });

        return inFlight;
    };
}
