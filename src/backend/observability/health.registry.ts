import { marketConfig } from '../config/market.config.js';
import { getPool } from '../db/pool.js';
import { DEFAULT_RETENTION_POLICIES } from '../db/retention.js';
import type {
    ComponentName,
    HealthComponent,
    HealthReport,
    IncidentLog,
} from './health.js';
import {
    createIncidentLog,
    HealthComponentSchema,
    isKnownComponent,
    summarize,
    unknownComponent,
} from './health.js';
import type { AlertVerdict, Metrics, MetricsSnapshot } from './metrics.js';
import { createMetrics, judgeSnapshot } from './metrics.js';

/**
 * The one place that knows what the system's parts are.
 *
 * Every check here names the component it belongs to, and a check for a name
 * the registry has never heard of comes back as `failing` rather than as
 * nothing. The alternative — assembling the list from whoever calls — produces
 * a health endpoint whose contents depend on who is looking, and a missing
 * component in that report is indistinguishable from a working one.
 *
 * The database is the only dependency injected. Everything else is either a
 * pure function or a module-level singleton that can be replaced through the
 * registry, so the whole report can be assembled in a test with nothing
 * running.
 */

export interface DatabaseProbe {
    /** Resolves if the database answers, rejects if it does not. */
    ping(): Promise<void>;
}

export interface MarketProbe {
    /**
     * The oldest bar across the markets this process observes, named.
     *
     * A single timestamp with a separate `symbol()` was the shape this used to
     * have, and it described one market while the process observed several. The
     * market travels with the reading so the report cannot pair a number from one
     * series with the name of another.
     */
    oldestCandle(): Promise<{ market: string; at: number }>;
    provider(): string;
    symbol(): string;
    interval(): string;
}

export interface SnapshotProbe {
    ageMs(): number;
    /**
     * A cached snapshot is serving the answer, and the answer is right.
     *
     * A function rather than a value for the same reason `ageMs` is one: both
     * are read at report time, and a snapshot that went stale while the process
     * was running has to be able to say so. A boolean captured at construction
     * is a constant wearing a measurement's name.
     */
    stale(): boolean;
    /**
     * Which market the age is about, or null when nothing has been observed yet.
     *
     * Null rather than a name so a report cannot claim a market was measured when
     * the process has not reached it.
     */
    oldestMarket(): string | null;
}

export interface HealthRegistryOptions {
    database: DatabaseProbe;
    /**
     * Optional, and defaulting to the process's own reading, which is the point.
     *
     * Both used to be required, so every caller had to hand-build a probe — and a
     * caller that did so with a stub got a registry that answered from the stub
     * and called itself healthy. It also forced the real probes to be assembled
     * outside `createHealthRegistry`, where the injected clock is not in scope, so
     * the age fell back to `Date.now` while everything else in the report came from
     * the registry's clock.
     */
    market?: MarketProbe;
    snapshot?: SnapshotProbe;
    now?: () => number;
    /** How old a snapshot may be before it is reported as degraded. */
    freshWithinMs?: number;
    /** The candle interval, to tell "an hour old" from "a year old". */
    candleIntervalMs?: number;
}

const DAY = 86_400_000;

/**
 * The market the process observes, read from the table rather than from memory.
 *
 * **Every configured market, and the oldest of them.** It read
 * `MAX(timestamp) WHERE symbol = $1` with the primary, and its own comment said what
 * that would do the day a second market was written: a stale BTCUSDT reported as
 * fresh because ETH moved. That day arrived with `MARKET_SYMBOLS`.
 *
 * A configured market with **no rows at all** counts as age zero, which makes it the
 * oldest and therefore the one reported. That is deliberate: an observed market with
 * no bars is not a market whose last bar is recent, it is a market the loop is not
 * filling, and reading it any other way is the confident-wrong answer this file
 * already has a note about. `/readyz` answers 503 on the database check alone, so a
 * `failing` component costs visibility rather than availability.
 */
function observedMarketProbe(): MarketProbe {
    return {
        async oldestCandle() {
            const rows = await getPool().query<{ symbol: string; last: number | null }>(
                `SELECT symbol, MAX(timestamp) AS last
                   FROM market_candles
                  WHERE symbol = ANY($1)
                  GROUP BY symbol`,
                [marketConfig.symbols],
            );

            const stored = new Map(rows.rows.map((row) => [row.symbol, row.last ?? 0]));

            let oldestMarket = marketConfig.symbol;
            let oldestAt = 0;

            // Iterates the configured markets, not the rows: a market the loop was
            // never asked about should not appear in the answer, and a market it was
            // asked about and that has nothing is the one worth hearing.
            for (const market of marketConfig.symbols) {
                const at = stored.get(market) ?? 0;

                if (oldestAt === 0 || at < oldestAt) {
                    oldestAt = at;
                    oldestMarket = market;
                }
            }

            return { market: oldestMarket, at: oldestAt };
        },
        // Read from configuration rather than written here. The registry used to
        // answer `'BTCUSDT'` and `'1d'` as literals, which made this file the second
        // of the two places in the domain that decided the system was about
        // Bitcoin — and it decided it in a message that says the last bar is fresh,
        // so the wrong market would have read as a healthy one.
        provider: () => marketConfig.provider,
        symbol: () => marketConfig.symbol,
        interval: () => marketConfig.candleInterval,
    };
}

/**
 * The freshness of what this process is holding, per market.
 *
 * **These two used to be `() => 0` and `false`, which is a health check that reports
 * «снимок получен напрямую» forever.** It said the system was serving fresh data at
 * every instant of its life, including every instant when it was serving week-old
 * candles, and it did so without a database call — which is the cheapest possible way
 * to be confidently wrong.
 *
 * What is measured here is the age of the newest bar the system holds, per market,
 * not the age of a cached snapshot, because no cached snapshot's age is recorded
 * anywhere in the project. The two differ, and claiming the second while measuring
 * the first would be the same fabrication with extra steps. So it is measured, it is
 * named for what it is, and the threshold comes from the same bar interval the market
 * component uses rather than from a number that was written once and never revisited.
 *
 * The **oldest** market, not whichever wrote last: one number for the whole process
 * meant the last market in the list won every cycle, so a dead market was masked by a
 * healthy one for as long as the healthy one kept reporting.
 */
function observedBarProbe(clock: () => number): SnapshotProbe {
    return {
        ageMs: () => oldestBarAgeMs(clock),
        stale: () => oldestBarAgeMs(clock) > 2 * marketConfig.candleIntervalMs,
        oldestMarket: () => oldestObservedBar(clock).market,
    };
}

export interface HealthRegistry {
    metrics(): Metrics;
    incidents(): IncidentLog;
    report(): Promise<HealthReport>;
    snapshot(takenAt: number): MetricsSnapshot;
    alerts(thresholds?: Parameters<typeof judgeSnapshot>[1]): AlertVerdict;
}

export function createHealthRegistry(options: HealthRegistryOptions): HealthRegistry {
    const metrics = createMetrics();
    const incidents = createIncidentLog();
    const now = options.now ?? (() => Date.now());

    // Resolved here rather than at the module boundary so that the age of a bar is
    // measured on the same clock as everything else in the report. When the real
    // probes were built outside, they had no access to `now` and used `Date.now` —
    // which made a report's `observedAt` and its `dataAgeMs` come from two different
    // clocks, and no test could say which.
    const market = options.market ?? observedMarketProbe();
    const snapshot = options.snapshot ?? observedBarProbe(now);
    const freshWithin = options.freshWithinMs ?? 2 * DAY;
    const interval = options.candleIntervalMs ?? DAY;

    async function check(name: ComponentName, work: () => Promise<HealthComponent>): Promise<HealthComponent> {
        if (!isKnownComponent(name)) {
            return unknownComponent(name);
        }

        const at = now();

        try {
            return await work();
        } catch (error) {
            const detail =
                error instanceof Error ? error.message : 'неизвестная ошибка';

            // Every failure enters the incident log, including the ones that
            // recover before anybody looks. A log that only holds what is
            // broken right now cannot answer "how often does this happen",
            // which is the question the log exists for.
            incidents.record(name, 'failing', detail, at);

            return HealthComponentSchema.parse({
                name,
                state: 'failing',
                detail,
                checkedInMs: 0,
                observedAt: at,
            });
        }
    }

    async function database(): Promise<HealthComponent> {
        const startedAt = Date.now();

        return await check('database', async () => {
            await options.database.ping();

            const at = now();

            return HealthComponentSchema.parse({
                name: 'database',
                state: 'ok',
                detail: 'отвечает',
                checkedInMs: Date.now() - startedAt,
                observedAt: at,
            });
        });
    }

    async function marketProvider(): Promise<HealthComponent> {
        return await check('market-provider', async () => {
            // The **oldest** market, not a named one. With more than one market a
            // single reading cannot describe the system: reporting the primary's
            // newest bar while a second market has been dead for a day is a
            // healthy-looking answer about a market that has no data.
            const oldest = await market.oldestCandle();
            const at = oldest.at;
            const observedAt = now();
            const age = observedAt - at;

            // Staleness is reported as its own state rather than folded into
            // the provider's, because a provider returning yesterday's bar and
            // a provider that returns nothing are different incidents with
            // different causes, and a dashboard that says "data is stale" for
            // both has thrown away the half that was actionable.
            const state =
                age <= freshWithin ? 'ok' : age <= 5 * freshWithin ? 'degraded' : 'failing';

            return HealthComponentSchema.parse({
                name: 'market-provider',
                state,
                detail:
                    state === 'ok'
                        ? `${oldest.market} ${market.interval()}: свежий бар`
                        : `последний бар ${oldest.market} ${market.interval()} старше на ${Math.floor(age / interval)} баров`,
                dataAgeMs: age,
                observedAt,
            });
        });
    }

    async function freshness(): Promise<HealthComponent> {
        return await check('market-freshness', async () => {
            const at = now();
            const age = snapshot.ageMs();

            return HealthComponentSchema.parse({
                name: 'market-freshness',
                // Degraded, never failing: the answer is still right, it is
                // just older than it should be, and reporting it as a failure
                // is a page for a working system.
                state: snapshot.stale() ? 'degraded' : 'ok',
                // The market is in the sentence because "a cached snapshot" is not
                // an actionable statement once there is more than one series: the
                // operator's first question is which one.
                detail: snapshot.stale()
                    ? `${snapshot.oldestMarket()}: отдаётся кэшированный снимок, ему ${Math.floor(age / 60_000)} мин`
                    : 'снимок получен напрямую',
                dataAgeMs: age,
                observedAt: at,
            });
        });
    }

    function retention(): HealthComponent {
        const at = now();
        const policies = DEFAULT_RETENTION_POLICIES;
        const protectedCount = policies.filter((policy) => policy.protected).length;

        return HealthComponentSchema.parse({
            name: 'retention',
            state: policies.length === 0 ? 'failing' : 'ok',
            detail:
                policies.length === 0
                    ? 'политики хранения не заданы: система будет копить всё подряд'
                    : `${policies.length} правил, из них защищено ${protectedCount}`,
            observedAt: at,
        });
    }

    return {
        metrics: () => metrics,
        incidents: () => incidents,

        async report() {
            const [db, provider, fresh] = await Promise.all([
                database(),
                marketProvider(),
                freshness(),
            ]);

            return summarize(
                [db, provider, fresh, retention()],
                now(),
            );
        },

        snapshot: (takenAt) => metrics.snapshot(takenAt),
        alerts: (thresholds) => judgeSnapshot(metrics.snapshot(now()), thresholds),
    };
}

/** The registry the running process uses. */
export const healthRegistry: HealthRegistry = createHealthRegistry({
    database: {
        async ping() {
            await getPool().query('SELECT 1');
        },
    },
});

/**
 * The newest bar this process has seen, per market.
 *
 * A `Map` and not one number, because two markets observing at once is the normal
 * case now and a single slot means whichever wrote last decides what `/readyz`
 * reports. That is the wrong way round: the question is not "which market spoke
 * most recently" but "which market is furthest behind".
 *
 * The **timestamp** is stored rather than the age, and the age is computed when it
 * is read. The age used to be computed at write time and returned verbatim, so
 * `dataAgeMs` was frozen at the last poll: a snapshot that went stale at 03:00 and
 * was asked about at 05:00 reported its age as of 03:00, and before the first poll
 * it reported `0`, which reads as "fresh".
 */
const newestBarAt = new Map<string, number>();

/**
 * Called by the poller, which is the only place that learns a bar arrived.
 *
 * The market is an argument rather than configuration because the cycle runs once
 * per market, and there is no single market left to read from configuration.
 */
export function observeNewestBar(market: string, timestamp: number): void {
    newestBarAt.set(market.trim().toUpperCase(), timestamp);
}

/**
 * The market furthest behind, and how far behind it is.
 *
 * Skips markets this process has not observed yet rather than counting them as
 * infinitely old: at boot the first cycle has not run, and reporting a market the
 * loop has not reached as the sickest one would be the mirror image of the bug
 * this replaces. A market that *was* observed and then went quiet is the case that
 * matters, and it is exactly the case a single slot could not catch.
 */
function oldestObservedBar(clock: () => number): { market: string | null; ageMs: number } {
    let oldestMarket: string | null = null;
    let oldestAgeMs = 0;

    for (const market of marketConfig.symbols) {
        const timestamp = newestBarAt.get(market);

        if (timestamp === undefined) {
            continue;
        }

        const ageMs = Math.max(0, clock() - timestamp);

        if (oldestMarket === null || ageMs > oldestAgeMs) {
            oldestAgeMs = ageMs;
            oldestMarket = market;
        }
    }

    return { market: oldestMarket, ageMs: oldestAgeMs };
}

function oldestBarAgeMs(clock: () => number): number {
    return oldestObservedBar(clock).ageMs;
}
