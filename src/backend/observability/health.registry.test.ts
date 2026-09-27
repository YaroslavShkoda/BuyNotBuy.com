import { describe, expect, it } from 'vitest';

import { createHealthRegistry } from './health.registry.js';
import { isKnownComponent, KNOWN_COMPONENTS } from './health.js';

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

function registry(overrides: {
    ping?: () => Promise<void>;
    lastCandleAt?: () => Promise<number>;
    ageMs?: number;
    stale?: boolean;
} = {}) {
    return createHealthRegistry({
        database: {
            ping:
                overrides.ping ?? (async () => {
                    /* healthy */
                }),
        },
        market: {
            lastCandleAt:
                overrides.lastCandleAt ?? (async () => NOW - 60_000),
            provider: () => 'binance',
            symbol: () => 'BTCUSDT',
            interval: () => '1d',
        },
        snapshot: {
            ageMs: () => overrides.ageMs ?? 1_000,
            stale: overrides.stale ?? false,
        },
        now: () => NOW,
        freshWithinMs: 2 * DAY,
        candleIntervalMs: DAY,
    });
}

function byName(
    report: { components: readonly { name: string; state: string; detail: string }[] },
    name: string,
) {
    const found = report.components.find((component) => component.name === name);

    if (found === undefined) {
        throw new Error(`no component ${name}`);
    }

    return found;
}

describe('every component the system claims to have is actually checked', () => {
    it('lists the same components every time, whatever ran', async () => {
        const report = await registry().report();

        // A health endpoint assembled by whoever calls answers a different
        // question for every request, and a component missing from it is
        // indistinguishable from a working one.
        expect(report.components.map((component) => component.name).sort()).toEqual(
            [...KNOWN_COMPONENTS].sort(),
        );
    });

    it('reports healthy when everything answers', async () => {
        const report = await registry().report();

        expect(report.healthy).toBe(true);
        expect(report.problems).toEqual([]);
    });

    it('calls a cached snapshot degraded, never failing', async () => {
        const report = await registry({ stale: true, ageMs: 3_600_000 }).report();

        // A page fired for a working-but-slightly-old dashboard trains people
        // to ignore pages.
        expect(byName(report, 'market-freshness').state).toBe('degraded');
        expect(report.state).toBe('degraded');
    });

    it('counts how many candles old the provider is, in bars', async () => {
        const report = await registry({ lastCandleAt: async () => NOW - 5 * DAY }).report();
        const provider = byName(report, 'market-provider');

        expect(provider.state).toBe('degraded');
        expect(provider.detail).toMatch(/старше на 5 баров/);
    });

    it('separates a stale provider from a dead one', async () => {
        const stale = await registry({ lastCandleAt: async () => NOW - 4 * DAY }).report();
        const dead = await registry({ lastCandleAt: async () => NOW - 400 * DAY }).report();

        // Two different incidents with two different causes. A dashboard that
        // says "data is stale" for both has thrown away the actionable half.
        expect(byName(stale, 'market-provider').state).toBe('degraded');
        expect(byName(dead, 'market-provider').state).toBe('failing');
    });

    it('reports a database that will not answer as failing, with its error', async () => {
        const report = await registry({
            ping: async () => {
                throw new Error('connection refused');
            },
        }).report();

        expect(report.state).toBe('failing');
        expect(byName(report, 'database').detail).toBe('connection refused');
    });

    it('carries the failure into the incident log, even a transient one', async () => {
        const health = registry({
            ping: async () => {
                throw new Error('connection refused');
            },
        });
        await health.report();

        // A log holding only what is broken right now cannot answer "how often
        // does this happen", which is the question it exists for.
        expect(health.incidents().state().open).toHaveLength(1);
        expect(health.incidents().state().open[0]?.component).toBe('database');
    });

    it('does not open a second incident while the first is still open', async () => {
        const health = registry({
            ping: async () => {
                throw new Error('connection refused');
            },
        });

        await health.report();
        await health.report();
        await health.report();

        expect(health.incidents().state().incidents).toHaveLength(1);
        expect(health.incidents().state().incidents[0]?.events).toHaveLength(1);
    });

    it('names the policies it is keeping, and how many are protected', async () => {
        const report = await registry().report();
        const retention = byName(report, 'retention');

        expect(retention.state).toBe('ok');
        expect(retention.detail).toMatch(/из них защищено 2/);
    });
});

describe('a component nobody described is reported, not omitted', () => {
    it('is failing, and says the name it has never heard of', () => {
        expect(isKnownComponent('a_component_somebody_invented')).toBe(false);
        expect(isKnownComponent('database')).toBe(true);
    });

    it('still shows up in the list rather than quietly disappearing', async () => {
        const report = await registry().report();

        // A check that discovers a name it has never heard of is exactly what
        // somebody needs to be told about, and reporting it ok would be how a
        // component vanishes from a dashboard without anyone removing it.
        expect(report.components).toHaveLength(KNOWN_COMPONENTS.length);
    });
});

describe('the metrics behind the health report are the ones the system records', () => {
    it('reports no durations before anything has been timed', () => {
        expect(registry().snapshot(NOW).durations).toEqual([]);
    });

    it('keeps the counters a caller has written into it', () => {
        const health = registry();
        health.metrics().started();
        health.metrics().failed('indicators');

        const snapshot = health.snapshot(NOW);

        expect(snapshot.counters.started).toBe(1);
        expect(snapshot.counters.byStage).toEqual({ indicators: 1 });
    });

    it('answers the alert question against its own metrics', () => {
        const health = registry();

        for (let index = 0; index < 100; index += 1) {
            health.metrics().duration('analysis', 20);
        }

        expect(health.alerts({ p99Ms: 5_000, minSample: 20 }).fires).toBe(false);
    });
});
