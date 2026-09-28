import {
    summarize,
    isKnownComponent,
    unknownComponent,
    createIncidentLog,
    HealthComponentSchema,
} from './health.js';
import { createMetrics, judgeSnapshot } from './metrics.js';
import { getPool } from '../db/pool.js';
import { DEFAULT_RETENTION_POLICIES } from '../db/retention.js';
import { marketConfig } from '../config/market.config.js';

import type {
    HealthComponent,
    HealthReport,
    IncidentLog,
    ComponentName,
} from './health.js';
import type { Metrics, MetricsSnapshot, AlertVerdict } from './metrics.js';

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
    /** Newest bar's timestamp, in the market's own clock. */
    lastCandleAt(): Promise<number>;
    provider(): string;
    symbol(): string;
    interval(): string;
}

export interface SnapshotProbe {
    ageMs(): number;
    /** A cached snapshot is serving the answer, and the answer is right. */
    stale: boolean;
}

export interface HealthRegistryOptions {
    database: DatabaseProbe;
    market: MarketProbe;
    snapshot: SnapshotProbe;
    now?: () => number;
    /** How old a snapshot may be before it is reported as degraded. */
    freshWithinMs?: number;
    /** The candle interval, to tell "an hour old" from "a year old". */
    candleIntervalMs?: number;
}

const DAY = 86_400_000;

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
            const at = await options.market.lastCandleAt();
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
                        ? `${options.market.symbol()} ${options.market.interval()}: свежий бар`
                        : `последний бар ${options.market.symbol()} ${options.market.interval()} старше на ${Math.floor(age / interval)} баров`,
                dataAgeMs: age,
                observedAt,
            });
        });
    }

    async function freshness(): Promise<HealthComponent> {
        return await check('market-freshness', async () => {
            const at = now();
            const age = options.snapshot.ageMs();

            return HealthComponentSchema.parse({
                name: 'market-freshness',
                // Degraded, never failing: the answer is still right, it is
                // just older than it should be, and reporting it as a failure
                // is a page for a working system.
                state: options.snapshot.stale ? 'degraded' : 'ok',
                detail: options.snapshot.stale
                    ? `отдаётся кэшированный снимок, ему ${Math.floor(age / 60_000)} мин`
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
    market: {
        async lastCandleAt() {
            // Filtered by the market being polled, and the filter is the point.
            // `MAX(timestamp)` across the whole table is the newest bar of
            // *any* market, while the message below names one — so the day a
            // second market is written to this table, a stale BTCUSDT would
            // have been reported as fresh because ETH moved. Today exactly one
            // market is written, so this changes nothing; it is here because the
            // day it would matter is the day nobody would be looking at this
            // query.
            const rows = await getPool().query<{ last: number | null }>(
                'SELECT MAX(timestamp) AS last FROM market_candles WHERE symbol = $1',
                [marketConfig.symbol],
            );

            return rows.rows[0]?.last ?? 0;
        },
        // Read from configuration rather than written here. The registry used
        // to answer `'BTCUSDT'` and `'1d'` as literals, which made this file
        // the second of the two places in the domain that decided the system
        // was about Bitcoin — and it decided it in a message that says the
        // last bar is fresh, so the wrong market would have read as a healthy
        // one. The name of the market being polled is configuration, and
        // configuration already holds it.
        provider: () => marketConfig.provider,
        symbol: () => marketConfig.symbol,
        interval: () => marketConfig.candleInterval,
    },
    snapshot: {
        ageMs: () => 0,
        stale: false,
    },
});
