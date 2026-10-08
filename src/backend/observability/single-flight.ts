/**
 * Collapsing identical concurrent work into one.
 *
 * Not a cache. This holds a promise for the duration of one call and forgets
 * it the moment that call settles. The distinction matters because the two get
 * confused constantly: a caller that gets a coalesced result has been told the
 * truth as of when the work started, not as of when they asked, and a cache
 * that kept the answer would be handing out a second reading of the market
 * under the same name.
 *
 * The second reason to want it is not performance. Two concurrent analyses
 * both fetch the market, both compute the signal, and both write a history row
 * for the same hour — and a history that records the same decision twice
 * teaches the calibration code that the market held still twice when it moved
 * once. That is a wrong number rather than a slow one, which is why the
 * coalescing is a correctness measure here and not only a cost one.
 *
 * Failures are **not** shared, and that is the most important decision here.
 * A caller that arrives while work is in flight joins it, and if that work
 * fails, the follower runs its own attempt rather than inheriting somebody
 * else's rejection. Otherwise one provider timeout arriving on the first of ten
 * concurrent requests would turn into ten failed page loads, and a dashboard
 * that is up would report itself as down because of a blip it had already
 * moved past. Two requests that both fail is a fact about the provider; one
 * request failing and nine succeeding is what actually happened.
 *
 * The cost is that a genuine outage sees one upstream attempt per caller, so
 * the coalescing stops protecting the provider exactly when it is down. That is
 * the right way round: the circuit breaker exists for that case, and it counts
 * attempts. A shared rejection would have made the breaker see one request and
 * open far too late.
 */

interface SingleFlight<T> {
    /**
     * Runs `work`, or joins the call already in flight.
     *
     * The boolean is whether this caller started the work. It exists for the
     * things that must happen exactly once per unit of work — a metric, a
     * write, a log line about starting rather than about finishing — where
     * counting it per caller would report several of something that happened
     * once.
     */
    run(work: () => Promise<T>): Promise<{ result: T; leader: boolean }>;
    /** Whether something is running right now. */
    readonly inFlight: boolean;
    /** Callers that joined rather than starting. */
    readonly joined: number;
    /** Callers that joined, were given somebody else's failure, and retried. */
    readonly retriedAfterSharedFailure: number;
}

export function createSingleFlight<T>(): SingleFlight<T> {
    let current: Promise<T> | null = null;
    let followers = 0;
    let retried = 0;

    return {
        async run(work) {
            if (current === null) {
                const leader = true;

                // Assigned before the first await inside `work` can resolve, so
                // a caller arriving in the same tick finds it. Assigning after
                // would open a window where every concurrent caller becomes its
                // own leader, which is the stampede this exists to prevent.
                current = (async () => work())().finally(() => {
                    current = null;
                });

                return { result: await current, leader };
            }

            followers += 1;

            try {
                return { result: await current, leader: false };
            } catch {
                // Somebody else's attempt failed. This caller's is its own.
                retried += 1;

                return { result: await work(), leader: true };
            }
        },

        get inFlight(): boolean {
            return current !== null;
        },

        get joined(): number {
            return followers;
        },

        get retriedAfterSharedFailure(): number {
            return retried;
        },
    };
}

interface KeyedSingleFlight<T> {
    /** The coalescer for one market, created on first use and then reused. */
    forMarket(key: string): SingleFlight<T>;
    /** Markets with a coalescer, whether or not one is running. */
    readonly keys: readonly string[];
    /** Drops every coalescer, for tests and the shutdown path. */
    reset(): void;
}

/**
 * One coalescer per market.
 *
 * **A single coalescer is a market-specific object that does not say so.** It
 * was correct when there was one market and it became wrong the moment there
 * were two: a caller that asked a EUR price while a BTC price was in flight
 * would join the BTC read, get the BTC answer, and see a perfectly ordinary
 * number under its own request's name. The cost is one upstream call per
 * in-flight market, which is the cost being bought.
 *
 * Counters stay per market, because "how often did a caller join a read it did
 * not start" is a question about one market's traffic, and summing across
 * markets would produce a number that could not be acted on.
 */
export function createKeyedSingleFlight<T>(): KeyedSingleFlight<T> {
    const flights = new Map<string, SingleFlight<T>>();

    return {
        forMarket(key: string): SingleFlight<T> {
            const existing = flights.get(key);

            if (existing !== undefined) {
                return existing;
            }

            const created = createSingleFlight<T>();

            flights.set(key, created);

            return created;
        },

        get keys(): readonly string[] {
            return [...flights.keys()];
        },

        reset(): void {
            flights.clear();
        },
    };
}
