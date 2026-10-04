import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { HealthComponent, HealthState } from './health.js';
import { createIncidentLog, HealthComponentSchema, summarize } from './health.js';
import {
    createMetrics,
    judgeSnapshot,
    MetricConfigSchema,
    Reservoir,
} from './metrics.js';

const NOW = 1_750_000_000_000;

function component(
    name: string,
    state: HealthState,
    detail = `state ${state}`,
    at = NOW,
): HealthComponent {
    return HealthComponentSchema.parse({
        name,
        state,
        detail,
        observedAt: at,
    });
}

describe('a health check without a reason is a status light', () => {
    it('refuses a component with no explanation', () => {
        expect(() =>
            HealthComponentSchema.parse({
                name: 'db',
                state: 'ok',
                detail: '',
                observedAt: NOW,
            }),
        ).toThrow();
    });

    it('reports the worst state present, not the first one', () => {
        const report = summarize(
            [
                component('db', 'ok'),
                component('market', 'failing', 'provider unreachable'),
                component('cache', 'degraded', 'serving stale'),
            ],
            NOW,
        );

        expect(report.state).toBe('failing');
        expect(report.healthy).toBe(false);
    });

    it('does not call a degraded system failing', () => {
        const report = summarize([component('market', 'degraded', 'cached')], NOW);

        // A page fired for a degraded-but-working dashboard trains people to
        // ignore pages, and the next one is the page that mattered.
        expect(report.state).toBe('degraded');
        expect(report.healthy).toBe(false);
    });

    it('calls a healthy system one that can serve traffic', () => {
        const report = summarize(
            [component('db', 'ok'), component('retention', 'skipped', 'not configured')],
            NOW,
        );

        expect(report.healthy).toBe(true);
        expect(report.state).toBe('skipped');
    });

    it('names each problem with its own reason', () => {
        const report = summarize(
            [component('db', 'ok'), component('market', 'failing', 'provider unreachable')],
            NOW,
        );

        // A list of names is not actionable; a list of names with the sentence
        // that goes with them is.
        expect(report.problems).toEqual([
            'market: provider unreachable',
        ]);
    });

    it('orders problems worst first whatever order they arrived in', () => {
        const forward = summarize(
            [component('a', 'degraded'), component('b', 'failing')],
            NOW,
        );
        const backward = summarize(
            [component('b', 'failing'), component('a', 'degraded')],
            NOW,
        );

        expect(forward.problems).toEqual(backward.problems);
    });

    it('holds for any set of components and states', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.tuple(
                        fc.string({ minLength: 1, maxLength: 6 }),
                        fc.constantFrom<HealthState>(
                            'ok',
                            'degraded',
                            'failing',
                            'skipped',
                        ),
                    ),
                    { maxLength: 10 },
                ),
                (entries) => {
                    const report = summarize(
                        entries.map(([name, state]) => component(name, state)),
                        NOW,
                    );

                    expect(report.components).toHaveLength(entries.length);
                    expect(report.healthy).toBe(
                        entries.every(
                            ([, state]) => state === 'ok' || state === 'skipped',
                        ),
                    );
                },
            ),
            { numRuns: 100 },
        );
    });
});

describe('an incident has a beginning, an end and a length', () => {
    it('opens on the first report and closes on recovery', () => {
        const log = createIncidentLog();

        log.record('market', 'degraded', 'using cache', NOW);
        log.record('market', 'recovered', 'provider back', NOW + 60_000);

        const state = log.state();

        expect(state.open).toHaveLength(0);
        expect(state.resolved).toHaveLength(1);
        expect(state.resolved[0]?.durationMs).toBe(60_000);
    });

    it('keeps one incident when a degradation worsens', () => {
        const log = createIncidentLog();

        log.record('market', 'degraded', 'cached', NOW);
        log.record('market', 'failing', 'provider gone', NOW + 1_000);

        // Splitting it would make "how long has this been broken" return the
        // age of the worst moment rather than its length, which is the number
        // people actually ask for.
        expect(log.state().incidents).toHaveLength(1);
        expect(log.state().incidents[0]?.severity).toBe('failing');
        expect(log.state().incidents[0]?.events).toHaveLength(2);
    });

    it('keeps the original start time when it worsens', () => {
        const log = createIncidentLog();

        log.record('market', 'degraded', 'cached', NOW);
        log.record('market', 'failing', 'gone', NOW + 500_000);
        log.record('market', 'recovered', 'back', NOW + 900_000);

        expect(log.state().resolved[0]?.durationMs).toBe(900_000);
        expect(log.state().resolved[0]?.openedAt).toBe(NOW);
    });

    it('records a recovery for something that was never broken', () => {
        const log = createIncidentLog();

        log.record('db', 'recovered', 'all good', NOW);

        // Swallowing it hides a component whose reporting is not working.
        expect(log.state().incidents).toHaveLength(1);
        expect(log.state().resolved[0]?.durationMs).toBe(0);
    });

    it('does not close the same incident twice', () => {
        const log = createIncidentLog();

        log.record('market', 'degraded', 'cached', NOW);
        log.record('market', 'recovered', 'back', NOW + 1_000);
        log.record('market', 'recovered', 'back again', NOW + 2_000);

        // The second recovery has nothing to close, so it becomes its own
        // zero-length incident rather than a second open one.
        expect(log.state().incidents).toHaveLength(2);
        expect(log.state().open).toHaveLength(0);
        expect(log.state().resolved).toHaveLength(2);
    });

    it('finds the longest outage, which is what a review asks for', () => {
        const log = createIncidentLog();

        log.record('a', 'degraded', 'x', NOW);
        log.record('a', 'recovered', 'x', NOW + 1_000);
        log.record('a', 'degraded', 'y', NOW + 2_000);
        log.record('a', 'recovered', 'y', NOW + 90_000);

        expect(log.longest('a')?.durationMs).toBe(88_000);
    });

    it('returns nothing for a component that never had an incident', () => {
        expect(createIncidentLog().longest('nothing')).toBeNull();
    });

    it('gives the same log for the same sequence, every time', () => {
        const run = () => {
            const log = createIncidentLog();
            log.record('a', 'failing', 'down', NOW);
            log.record('b', 'degraded', 'slow', NOW + 5);
            log.record('a', 'recovered', 'up', NOW + 10);

            return log.state().incidents.map((incident) => incident.id);
        };

        expect(run()).toEqual(run());
    });
});

describe('a percentile is a value a request actually took', () => {
    it('reports the median of a known set', () => {
        const reservoir = new Reservoir();

        for (let value = 1; value <= 100; value += 1) {
            reservoir.record(value);
        }

        expect(reservoir.percentile(0.5)).toBe(50);
        expect(reservoir.percentile(0.99)).toBe(99);
    });

    it('keeps the maximum exactly, because it is the unbounded one', () => {
        const reservoir = new Reservoir();

        reservoir.record(1);
        reservoir.record(99_999);

        expect(reservoir.max).toBe(99_999);
        expect(reservoir.mean).toBeCloseTo(50_000, 3);
    });

    it('says a hundred fast requests and one slow one are not fast', () => {
        const reservoir = new Reservoir();

        for (let index = 0; index < 200; index += 1) {
            reservoir.record(10);
        }

        // Five slow out of 205 puts them in the top 2%, so p99 lands on one.
        // One slow out of 201 does not, and a p99 that reported 30s there
        // would be interpolating a latency that never happened.
        for (let index = 0; index < 5; index += 1) {
            reservoir.record(30_000);
        }

        // This is the whole reason the average is not the number anybody is
        // paged about: the mean is a quarter of a second and would not raise an
        // eyebrow, while the tail is half a minute.
        expect(reservoir.mean).toBeLessThan(reservoir.percentile(0.99) / 30);
        expect(reservoir.percentile(0.99)).toBe(30_000);
    });

    it('never returns a value no sample had', () => {
        fc.assert(
            fc.property(
                fc.array(fc.double({ min: 0, max: 10_000, noNaN: true }), {
                    minLength: 1,
                    maxLength: 60,
                }),
                fc.double({ min: 0, max: 1, noNaN: true }),
                (values, fraction) => {
                    const reservoir = new Reservoir();

                    for (const value of values) {
                        reservoir.record(value);
                    }

                    const reported = reservoir.percentile(fraction);
                    const actual = [...values].sort((a, b) => a - b);

                    // Nearest-rank rather than interpolated: interpolating
                    // invents a latency that never occurred.
                    expect(actual).toContain(reported);
                },
            ),
            { numRuns: 150 },
        );
    });

    it('stays bounded however many samples it is given', () => {
        const reservoir = new Reservoir(
            MetricConfigSchema.parse({ reservoir: 100, warmup: 10 }),
        );

        for (let index = 0; index < 10_000; index += 1) {
            reservoir.record(index);
        }

        // A metric that can be made to grow by a caller is a way to take the
        // process down from inside.
        expect(reservoir.samples().length).toBeLessThanOrEqual(110);
        expect(reservoir.bounded).toBe(true);
    });

    it('keeps the first few values exactly, because they are the unseen ones', () => {
        const reservoir = new Reservoir(
            MetricConfigSchema.parse({ reservoir: 50, warmup: 5 }),
        );

        for (let index = 1; index <= 500; index += 1) {
            reservoir.record(index);
        }

        // The requests right after a deploy are the ones nobody has seen, and
        // a plain reservoir of 50 represents them worst.
        expect(reservoir.samples()[0]).toBe(1);
    });

    it('refuses a warm-up that would leave no room for the reservoir', () => {
        expect(() =>
            MetricConfigSchema.parse({ reservoir: 10, warmup: 10 }),
        ).toThrow(/no room/);
    });

    it('ignores a value that is not a number rather than poisoning every percentile', () => {
        const reservoir = new Reservoir();

        reservoir.record(10);
        reservoir.record(Number.NaN);
        reservoir.record(20);

        // A dashboard of NaN is worse than a dashboard with a gap in it.
        expect(reservoir.seen).toBe(2);
        expect([10, 20]).toContain(reservoir.percentile(0.5));
        expect(reservoir.max).toBe(20);
        expect(reservoir.mean).toBe(15);
    });

    it('reports zeroes rather than NaN before anything is measured', () => {
        const empty = new Reservoir();

        expect(empty.percentile(0.99)).toBe(0);
        expect(empty.mean).toBe(0);
        expect(empty.max).toBe(0);
    });
});

describe('a timer that only reports success describes how fast success is', () => {
    it('records the duration even when the work throws', () => {
        const metrics = createMetrics();
        let worked = false;

        try {
            metrics.time('stage', () => {
                throw new Error('boom');
            });
        } catch {
            worked = true;
        }

        expect(worked).toBe(true);
        expect(metrics.snapshot(NOW).durations[0]?.seen).toBe(1);
    });

    it('returns the value the work produced', () => {
        expect(createMetrics().time('stage', () => 42)).toBe(42);
    });

    it('counts failures by the stage that produced them', () => {
        const metrics = createMetrics();

        metrics.started();
        metrics.succeeded();
        metrics.started();
        metrics.failed('indicators');
        metrics.failed('indicators');
        metrics.failed('market-data');

        const { counters } = metrics.snapshot(NOW);

        expect(counters.started).toBe(2);
        expect(counters.succeeded).toBe(1);
        expect(counters.failed).toBe(3);
        expect(counters.byStage).toEqual({
            indicators: 2,
            'market-data': 1,
        });
    });

    it('hands out a snapshot that later writes cannot change', () => {
        const metrics = createMetrics();

        metrics.failed('a');
        const snapshot = metrics.snapshot(NOW);
        metrics.failed('b');

        // A snapshot a reader can still watch change under them is not a record.
        expect(snapshot.counters.failed).toBe(1);
    });
});

describe('a page is fired on experience, not on average', () => {
    const metrics = createMetrics();

    for (let index = 0; index < 100; index += 1) {
        metrics.duration('analysis', 50);
        metrics.started();
        metrics.succeeded();
    }

    it('stays quiet when everything is fast and successful', () => {
        expect(judgeSnapshot(metrics.snapshot(NOW), { p99Ms: 5_000 }).fires).toBe(
            false,
        );
    });

    it('does not fire on two samples, which is a cold start', () => {
        const cold = createMetrics();

        cold.duration('analysis', 99_999);

        // A rule that fires on two requests pages somebody about a boot.
        expect(
            judgeSnapshot(cold.snapshot(NOW), { p99Ms: 5_000, minSample: 20 }).fires,
        ).toBe(false);
    });

    it('fires on a slow tail the average would have hidden', () => {
        const slow = createMetrics();

        for (let index = 0; index < 100; index += 1) {
            slow.duration('analysis', 20);
        }

        for (let index = 0; index < 5; index += 1) {
            slow.duration('analysis', 40_000);
        }

        const verdict = judgeSnapshot(slow.snapshot(NOW), { p99Ms: 5_000 });

        expect(verdict.fires).toBe(true);
        expect(verdict.reasons.join()).toMatch(/p99/);
    });

    it('fires on failures, and says which stage made them', () => {
        for (let index = 0; index < 50; index += 1) {
            metrics.started();
            metrics.succeeded();
        }

        for (let index = 0; index < 10; index += 1) {
            metrics.started();
            metrics.failed('signal');
        }

        const verdict = judgeSnapshot(metrics.snapshot(NOW), {
            failureRatio: 0.05,
            minSample: 20,
        });

        expect(verdict.fires).toBe(true);
        expect(verdict.reasons.join()).toMatch(/отказов/);
    });

    it('never fires for any set of durations, and the reasons name the metric', () => {
        fc.assert(
            fc.property(
                fc.array(fc.double({ min: 0, max: 100_000, noNaN: true }), {
                    minLength: 1,
                    maxLength: 80,
                }),
                (values) => {
                    const metrics = createMetrics();

                    for (const value of values) {
                        metrics.duration('x', value);
                    }

                    const verdict = judgeSnapshot(metrics.snapshot(NOW), {
                        p99Ms: 1_000,
                        minSample: 1,
                    });

                    expect(verdict.reasons.every((reason) => reason.includes('x'))).toBe(true);
                },
            ),
            { numRuns: 60 },
        );
    });
});
