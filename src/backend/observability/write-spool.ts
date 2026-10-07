import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    writeSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * A durable overflow lane for the write backlogs.
 *
 * The bounded memory buffers hold records through a transient database outage,
 * and they are bounded on purpose: a long outage must not become unbounded
 * memory growth. The bound is the loss. The oldest entries are evicted during
 * exactly the outage that makes them worth keeping, and the cost is not
 * symmetrical across the three series: signal history is the evidence a
 * promotion decision is argued from, votes are what the hit rates are computed
 * from, and the decision journal is what a promotion has to be audited against.
 * "The buffer holds a day" is only true of one of the three — a vote batch and
 * a decision row arrive per cycle, so their bounds cover minutes, not hours.
 *
 * This is the fix the bounds were asking for, and the shape was chosen by
 * elimination:
 *
 * - **Not a queue inside PostgreSQL.** The failure being survived is
 *   PostgreSQL being down; a durable queue in the same process, on the same
 *   host, behind the same connection is the same failure domain wearing a
 *   different name.
 * - **Not Redis, not Kafka.** One process, one host, three appenders. A broker
 *   buys ordering and fan-out that three idempotent sinks do not need, at the
 *   price of a second stateful service to keep alive.
 * - **A local append-only file per series.** Appended and fsynced before the
 *   caller is told the entry was spooled, so a crash, a deploy, or an outage
 *   longer than any bound leaves the entries on disk; drained oldest-first
 *   into the same writes the memory buffers use. Replay safety is already
 *   earned — history upserts by hour bucket, votes upsert under a timestamp
 *   guard, decisions insert with `ON CONFLICT (symbol, created_at) DO
 *   NOTHING` — so at-least-once here lands as exactly-once there.
 *
 * Every entry that crosses this module is plain JSON: numbers, strings,
 * booleans, nulls, arrays, plain objects. That is not a style preference — the
 * timestamps are epoch `number`s on purpose, and a `Date` in an entry would
 * come back from the file as a string and break the very write it was spooled
 * for. The compiler cannot check a round-trip through a disk; this paragraph
 * is the check.
 *
 * Failure posture, in order: the database refuses a write and the writer calls
 * `append`; the spool refuses too (disk full, directory gone) and the writer
 * falls back to its memory buffer — the behaviour that existed before this
 * file, degraded but never broken. An entry the database refuses for good is
 * `drop`ped under the same bounded-attempts rule the memory buffers apply,
 * into the same `dropped_total` the operator already reads; a line the process
 * died mid-append is skipped and counted at boot rather than parsed and
 * trusted, because append fsyncs the entry and its newline together, so a file
 * not ending in a newline contains an append that never finished.
 *
 * Compaction is lazy, and safe to defer: removing entries from the head leaves
 * a dead prefix in the file until the next rewrite, and a crash in between
 * only means entries the database already accepted are replayed — which their
 * sinks fold away as no-ops. The byte bound is checked against the file's real
 * size, not the queue's, so the prefix cannot hide growth. The rewrite is
 * tmp-plus-rename without a directory fsync, because Windows cannot fsync a
 * directory at all and the worst case on power loss is the pre-compaction
 * file surviving — the no-op replay above, not a loss.
 *
 * Synchronous fs calls, and deliberately: three appends a minute at worst, so
 * the simplicity of never interleaving two writes into one descriptor is worth
 * more than the microseconds async would save.
 *
 * It lives in `observability` for the same reason the bounded buffers do:
 * everything may count through it, and it touches no database.
 */
export interface WriteSpool<T> {
    /**
     * Appends the entry durably, or reports that it could not. `false` sends
     * the writer to its memory buffer; the queue and the file are only ever
     * updated after the write has succeeded, so they cannot disagree.
     */
    append(entry: T): boolean;
    /** The oldest spooled entry, without removing it. */
    peek(): T | undefined;
    /** Removes the oldest entry — its database write has succeeded. */
    confirm(): void;
    /** Removes the oldest entry — the database has refused it for good. */
    drop(): void;
    /**
     * Moves the oldest entry to the back of the queue — a row the database
     * refuses for a reason of its own must not stall the entries behind it on
     * every flush, which is the same anti-stall rule the memory buffers
     * already apply. The file's order catches up at the next rewrite, and a
     * crash in between only replays the entries in the old order, which the
     * idempotent sinks fold away.
     */
    rotate(): void;
    /**
     * Rewrites the file down to the entries still pending. Idempotent and free
     * when nothing was confirmed or dropped since the last rewrite; the flush
     * loops call it once at the end of a drain, not once per entry.
     */
    compact(): void;
    /** Entries currently held, oldest first — the same order the file is read back in. */
    readonly size: number;
    /** Entries evicted past the byte bound since the process started. */
    readonly evictedCount: number;
    /** Lines skipped at boot because their append never finished. */
    readonly tornCount: number;
    /**
     * The spool's own half of the per-market record: what it holds and what it
     * has evicted, keyed by market. The buffer's half lives next door, and
     * `mergeBacklogStates` is where the two become the one record an operator
     * reads.
     */
    readonly byMarket: SpoolBacklogStateByMarket;
    /**
     * True once the spool failed to come up (directory, unreadable file) and
     * will refuse every append until the process restarts. Permanent on
     * purpose: an operator reads a counter that says the fallback is live,
     * rather than a spool that limps and logs.
     */
    readonly refused: boolean;
}

/**
 * The spool's half of a per-market backlog: entries on disk now, entries lost
 * to the byte bound since the process started. Torn lines are absent by
 * construction — a line that never finished appending was never parsed, so
 * there is no entry to ask a market of, and that loss is counted in the
 * totals only.
 */
export interface SpoolBacklogState {
    spooled: number;
    dropped: number;
}

/** The per-market split of a spool, keyed by market. */
export type SpoolBacklogStateByMarket = Readonly<Record<string, SpoolBacklogState>>;

export interface WriteSpoolOptions<T> {
    /**
     * Which series this spool holds, for the file name and the operator
     * reading a counter: `signal_history`, `indicator_vote`, `strategy_decision`.
     */
    name: string;
    directory: string;
    /**
     * Hard ceiling on the file, in bytes. Oldest entries are evicted past it —
     * the same policy as the memory buffers, because the oldest entry is the
     * least useful to keep under either roof.
     */
    maxBytes: number;
    /**
     * Whether the spool is on. Off, every `append` is refused and the writers
     * fall back to their memory buffers; nothing about the write paths changes.
     */
    enabled: boolean;
    /**
     * The market an entry belongs to, for the per-market counters.
     *
     * Required rather than optional, and for the reason the memory buffers
     * give: a spool that could not attribute its evictions would make
     * `byMarket` silently read as if nothing on disk belonged to anyone, and
     * one market's long outage evicting a healthy market's entries is exactly
     * the fact the split exists to expose.
     */
    marketOf: (entry: T) => string;
}

export function createWriteSpool<T>(options: WriteSpoolOptions<T>): WriteSpool<T> {
    const path = join(options.directory, `${options.name}.jsonl`);
    const tmpPath = `${path}.tmp`;

    const entries: T[] = [];

    let fd: number | null = null;
    let fileBytes = 0;
    let dirty = false;
    let refused = false;
    let evicted = 0;
    let torn = 0;

    // Remembered rather than recounted, for the reason the memory buffer gives:
    // an eviction removes the entry, so by the time anyone asks there is nothing
    // left to count it from.
    const evictedByMarket = new Map<string, number>();

    function rewrite(): boolean {
        const contents = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');

        // Closed before the rename, and reopened lazily by the next append:
        // Windows cannot rename over a file that has an open handle, so the
        // append descriptor held across rewrites would make every compaction
        // fail — quietly, and only on the machine that develops this.
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // Already gone; nothing to close.
            }

            fd = null;
        }

        try {
            const tmpFd = openSync(tmpPath, 'w');

            try {
                writeSync(tmpFd, contents);
                fsyncSync(tmpFd);
            } finally {
                closeSync(tmpFd);
            }

            renameSync(tmpPath, path);
        } catch {
            // The old file survives a failed rewrite, and with it the durable
            // copy of everything still in the queue. `dirty` stays set, so the
            // next append or compact retries.
            return false;
        }

        fileBytes = Buffer.byteLength(contents, 'utf8');
        dirty = false;

        return true;
    }

    function shift(): void {
        entries.shift();
        dirty = true;
    }

    if (options.enabled) {
        try {
            mkdirSync(options.directory, { recursive: true });

            // No file yet is not an offence — it means nothing has ever been
            // spooled, and the first append creates the file.
            let raw: string | null = null;

            try {
                raw = readFileSync(path, 'utf8');
            } catch {
                raw = null;
            }

            if (raw !== null) {
                const lines = raw.split('\n');
                const endedCleanly = lines[lines.length - 1] === '';

                if (!endedCleanly) {
                    torn += 1;
                }

                // Either the trailing '' of a clean file or the torn fragment
                // of an interrupted append; neither is a candidate entry.
                const complete = lines.slice(0, -1);

                for (const line of complete) {
                    if (line === '') {
                        torn += 1;

                        continue;
                    }

                    try {
                        entries.push(JSON.parse(line) as T);
                    } catch {
                        torn += 1;
                    }
                }

                // The file's real size, torn fragment included: the bound is
                // checked against it, so the fragment cannot hide growth.
                fileBytes = Buffer.byteLength(raw, 'utf8');

                if (torn > 0) {
                    dirty = true;
                }
            }
        } catch {
            refused = true;
        }
    }

    return {
        append(entry: T): boolean {
            if (!options.enabled || refused) {
                return false;
            }

            const line = `${JSON.stringify(entry)}\n`;
            const lineBytes = Buffer.byteLength(line, 'utf8');

            if (fileBytes + lineBytes > options.maxBytes) {
                while (entries.length > 0 && fileBytes + lineBytes > options.maxBytes) {
                    const evictedEntry = entries.shift();

                    if (evictedEntry !== undefined) {
                        const market = options.marketOf(evictedEntry);

                        evictedByMarket.set(market, (evictedByMarket.get(market) ?? 0) + 1);
                    }

                    evicted += 1;
                }

                // Evicting from the queue does not free bytes until the file is
                // rewritten; a failed rewrite means the spool is not taking
                // writes right now, and the caller falls back.
                if (!rewrite()) {
                    return false;
                }
            }

            try {
                if (fd === null) {
                    fd = openSync(path, 'a');
                }

                writeSync(fd, line);
                fsyncSync(fd);
            } catch {
                // The descriptor may be dead — disk full, directory gone. Close
                // it so the next append reopens fresh instead of retrying a
                // broken descriptor for the rest of the process's life.
                if (fd !== null) {
                    try {
                        closeSync(fd);
                    } catch {
                        // Already gone; nothing to close.
                    }
                }

                fd = null;

                return false;
            }

            // Only after the write is on disk: the queue and the file must
            // agree, or boot would resurrect an entry the writer already
            // handed to its memory buffer as a fallback.
            entries.push(entry);
            fileBytes += lineBytes;

            return true;
        },

        peek(): T | undefined {
            return entries[0];
        },

        confirm(): void {
            shift();
        },

        drop(): void {
            shift();
        },

        rotate(): void {
            const head = entries.shift();

            if (head !== undefined) {
                entries.push(head);
            }

            dirty = true;
        },

        compact(): void {
            if (!dirty) {
                return;
            }

            rewrite();
        },

        get size(): number {
            return entries.length;
        },

        get evictedCount(): number {
            return evicted;
        },

        get tornCount(): number {
            return torn;
        },

        get byMarket(): SpoolBacklogStateByMarket {
            // Counted from what is in the queue, not remembered, for the same
            // reason the memory buffer recounts: a market that drained cleanly
            // must read as 0 spooled.
            const spooled = new Map<string, number>();

            for (const entry of entries) {
                const market = options.marketOf(entry);

                spooled.set(market, (spooled.get(market) ?? 0) + 1);
            }

            const markets = new Set<string>([...spooled.keys(), ...evictedByMarket.keys()]);

            const state: Record<string, SpoolBacklogState> = {};

            for (const market of [...markets].sort()) {
                state[market] = {
                    spooled: spooled.get(market) ?? 0,
                    dropped: evictedByMarket.get(market) ?? 0,
                };
            }

            return state;
        },

        get refused(): boolean {
            return refused;
        },
    };
}
