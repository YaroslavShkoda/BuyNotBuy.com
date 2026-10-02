import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHealthRegistry } from './health.registry.js';
import { isKnownComponent, KNOWN_COMPONENTS } from './health.js';

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

function registry(overrides: {
    ping?: () => Promise<void>;
    oldestCandle?: () => Promise<{ market: string; at: number }>;
    ageMs?: number;
    stale?: boolean;
    oldestMarket?: string | null;
} = {}) {
    return createHealthRegistry({
        database: {
            ping:
                overrides.ping ?? (async () => {
                    /* healthy */
                }),
        },
        market: {
            oldestCandle:
                overrides.oldestCandle ??
                (async () => ({ market: 'BTCUSDT', at: NOW - 60_000 })),
            provider: () => 'binance',
            symbol: () => 'BTCUSDT',
            interval: () => '1d',
        },
        snapshot: {
            ageMs: () => overrides.ageMs ?? 1_000,
            stale: () => overrides.stale ?? false,
            oldestMarket: () => overrides.oldestMarket ?? 'BTCUSDT',
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
        const report = await registry({ oldestCandle: async () => ({ market: 'BTCUSDT', at: NOW - 5 * DAY }) }).report();
        const provider = byName(report, 'market-provider');

        expect(provider.state).toBe('degraded');
        expect(provider.detail).toMatch(/старше на 5 баров/);
    });

    it('separates a stale provider from a dead one', async () => {
        const stale = await registry({ oldestCandle: async () => ({ market: 'BTCUSDT', at: NOW - 4 * DAY }) }).report();
        const dead = await registry({ oldestCandle: async () => ({ market: 'BTCUSDT', at: NOW - 400 * DAY }) }).report();

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


describe('freshness across more than one market', () => {
    const CYCLE_ONE = 1_750_000_000_000;

    /**
     * One module instance, one registry, one clock the test moves.
     *
     * The first version of this harness re-imported the module for every report,
     * and  gave it a **fresh** observation map — so the two
     * cycles below did not share a memory and the second cycle could not see the
     * first one's bars. It passed for the wrong reason: the answer looked healthy
     * because nothing had been observed at all, which is the same healthy-looking
     * answer the item is about.
     */
    async function harness(): Promise<{
        observe: (market: string, timestamp: number) => void;
        advance: (ms: number) => void;
        freshness: () => Promise<{ state: string; detail: string; dataAgeMs?: number | undefined }>;
    }> {
        vi.resetModules();

        vi.stubEnv('MARKET_SYMBOL', 'BTCUSDT');
        vi.stubEnv('MARKET_SYMBOLS', 'ETHUSDT');

        const { createHealthRegistry, observeNewestBar } = await import('./health.registry.js');

        let clock = CYCLE_ONE;

        const registry = createHealthRegistry({
            database: {
                async ping() {
                    /* healthy */
                },
            },
            now: () => clock,
            freshWithinMs: 2 * DAY,
            candleIntervalMs: DAY,
        });

        return {
            observe: (market, timestamp) => observeNewestBar(market, timestamp),
            advance: (ms) => {
                clock += ms;
            },
            freshness: async () => {
                const report = await registry.report();
                const component = report.components.find((c) => c.name === 'market-freshness');

                return {
                    state: component?.state ?? 'missing',
                    detail: component?.detail ?? '',
                    dataAgeMs: component?.dataAgeMs,
                };
            },
        };
    }

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('catches a market that stops reporting while another keeps going', async () => {
        // **This is the item.** One integer for the whole process meant the last
        // market to write won every cycle — and the last market to write is always
        // the healthy one, because a market that stopped reporting writes nothing.
        // So the single slot could not express this failure at all: the dead market
        // was not reported badly, it was never in the answer.
        //
        // Two cycles. In the first both markets are observed. In the second only
        // the primary is, because the other venue failed and the cycle moved on —
        // which per-market isolation (round 86) made a normal event.
        const run = await harness();

        run.observe('BTCUSDT', CYCLE_ONE);
        run.observe('ETHUSDT', CYCLE_ONE);

        run.advance(DAY);
        run.observe('BTCUSDT', CYCLE_ONE + DAY);

        const result = await run.freshness();

        // A day old is past the threshold, and the sentence has to name the market:
        // «отдаётся кэшированный снимок» is not actionable once there is more than
        // one series.
        expect(result.state).toBe('degraded');
        expect(result.detail).toContain('ETHUSDT');
        expect(result.dataAgeMs).toBe(DAY);
    });

    it('says ok when both markets are being observed', async () => {
        const run = await harness();

        run.observe('BTCUSDT', CYCLE_ONE);
        run.observe('ETHUSDT', CYCLE_ONE);
        run.advance(60_000);
        run.observe('BTCUSDT', CYCLE_ONE + 60_000);
        run.observe('ETHUSDT', CYCLE_ONE + 60_000);

        const result = await run.freshness();

        expect(result.state).toBe('ok');
    });

    it('reports the primary when the second market has never been observed', async () => {
        // The boot case, and the reason unobserved markets are not counted as
        // infinitely old: at boot the cycle has not reached the second market yet,
        // and calling it the sickest one would be the mirror image of the bug this
        // replaced.
        const run = await harness();

        run.observe('BTCUSDT', CYCLE_ONE);
        run.advance(60_000);

        const result = await run.freshness();

        expect(result.state).toBe('ok');
        expect(result.dataAgeMs).toBe(60_000);
    });

    it('grows between two reports without a new observation', async () => {
        // The part with nothing to do with markets: the age used to be computed when
        // the bar was observed and returned verbatim, so a snapshot that went stale
        // at 03:00 and was asked about at 05:00 reported its age as of 03:00, and
        // before the first observation it reported zero — which reads as fresh.
        const run = await harness();

        run.observe('BTCUSDT', CYCLE_ONE);

        expect((await run.freshness()).dataAgeMs).toBe(0);

        run.advance(60_000);

        expect((await run.freshness()).dataAgeMs).toBe(60_000);
    });
});
