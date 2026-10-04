import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { METRIC_NAMES } from '../observability/metrics.js';
import { MetricRegistry, useRegistry } from '../observability/registry.js';
import type { IndicatorSignal } from './signal.types.js';
import {
    churnRate,
    lastPublishedSignal,
    recordPublishedSignal,
    resetPublishedSignals,
} from './signal-publication.js';

const DIRECTIONS: IndicatorSignal[] = ['LONG', 'SHORT', 'NEUTRAL'];

describe('the metrics are recorded where the work happens, not where it is reported', () => {
    let registry: MetricRegistry;

    beforeEach(() => {
        registry = new MetricRegistry();
        useRegistry(registry);
        // The "previous signal" is process memory by design, so it survives
        // between tests exactly as it survives between requests. Every test
        // that reads the counters has to start from the state a restart would.
        resetPublishedSignals();
    });

    afterEach(() => {
        useRegistry(null);
    });

    it('counts a signal that was actually published to a caller', () => {
        recordPublishedSignal('LONG');
        recordPublishedSignal('LONG');

        expect(registry.value('signal_generation_total')).toBe(2);
    });

    it('counts NEUTRAL as a generated signal, because it is an answer', () => {
        recordPublishedSignal('NEUTRAL');

        // A counter that skipped HOLD would say the system had stopped working
        // exactly when it had correctly decided to do nothing.
        expect(registry.value('signal_generation_total')).toBe(1);
    });

    it('counts a change only when the direction differs from the last one', () => {
        recordPublishedSignal('LONG');
        recordPublishedSignal('LONG');
        recordPublishedSignal('SHORT');
        recordPublishedSignal('LONG');

        expect(registry.value('signal_changes_total')).toBe(2);
    });

    it('publishes the total unlabelled, so asking for it by name works', () => {
        recordPublishedSignal('LONG');
        recordPublishedSignal('SHORT');

        // The first version carried a from/to label, so the series that existed
        // was signal_changes_total{from="LONG",to="SHORT"} and the metric the
        // roadmap promised read as null to anyone who asked for it by name. A
        // counter behind a label needs sum by () on the far side, and that gets
        // forgotten once and then reads as zero forever.
        expect(registry.value('signal_changes_total')).toBe(1);
    });

    it('does not count the first signal as a change', () => {
        recordPublishedSignal('LONG');

        // With no memory of a previous one, nothing supports the other answer.
        expect(registry.value('signal_changes_total')).toBe(0);
    });

    it('forgets the previous signal on a restart, and says so with a zero', () => {
        recordPublishedSignal('LONG');
        resetPublishedSignals();
        recordPublishedSignal('SHORT');

        // Not a bug, and worth pinning: the first signal after a restart is
        // not a change, because there is no earlier signal to have changed
        // from. The alternative — treating it as a change — would report a flip
        // on every deploy of a system that had not moved at all.
        expect(registry.value('signal_changes_total')).toBe(0);
        expect(registry.value('signal_generation_total')).toBe(2);
    });

    it('remembers the last direction, which is what the next call compares against', () => {
        expect(lastPublishedSignal()).toBeNull();
        recordPublishedSignal('SHORT');
        expect(lastPublishedSignal()).toBe('SHORT');
    });

    it('reports churn as null rather than dividing by nothing', () => {
        // A division of two counters by hand is exactly where a zero
        // denominator quietly becomes a NaN on somebody's graph.
        expect(churnRate()).toBeNull();
    });

    it('makes a thousand answers and two changes visible as a ratio', () => {
        for (let index = 0; index < 1000; index += 1) {
            recordPublishedSignal('LONG');
        }

        recordPublishedSignal('SHORT');
        recordPublishedSignal('LONG');

        // The generation counter alone would show a healthy thousand, and a
        // system that answers a thousand times and changes twice has stopped
        // noticing the market.
        expect(registry.value('signal_generation_total')).toBe(1002);
        expect(churnRate()).toBeCloseTo(2 / 1002, 10);
    });

    it('never counts more changes than signals', () => {
        fc.assert(
            fc.property(
                fc.array(fc.constantFrom(...DIRECTIONS), { maxLength: 60 }),
                (sequence) => {
                    resetPublishedSignals();

                    const fresh = new MetricRegistry();
                    useRegistry(fresh);

                    for (const direction of sequence) {
                        recordPublishedSignal(direction);
                    }

                    const generated = fresh.value('signal_generation_total') ?? 0;
                    const changed = fresh.value('signal_changes_total') ?? 0;

                    expect(changed).toBeLessThanOrEqual(generated);
                    expect(changed).toBeLessThanOrEqual(sequence.length);
                },
            ),
            { numRuns: 100 },
        );
    });
});

describe('the exposition carries the whole promise or none of it', () => {
    it('names every promised metric, even the ones nothing has recorded yet', () => {
        const rendered = new MetricRegistry().render({ namespace: 'buynotbuy_' });

        for (const name of METRIC_NAMES) {
            expect(rendered).toContain(`buynotbuy_${name}`);
        }
    });

    it('keeps the eight that had nowhere to be recorded before', () => {
        const rendered = new MetricRegistry().render({ namespace: 'buynotbuy_' });

        // These eight were the gap: the old exposition published five provider
        // series and had no place at all for the cache, the indicators, the
        // signals, the database or the backtest.
        for (const name of [
            'market_cache_hits',
            'market_cache_misses',
            'market_stale_served',
            'indicator_calculation_duration',
            'signal_generation_total',
            'signal_changes_total',
            'database_query_duration',
            'backtest_duration',
        ]) {
            expect(rendered).toContain(name);
        }
    });
});

describe('the previous signal is remembered per market', () => {
    let registry: MetricRegistry;

    beforeEach(() => {
        registry = new MetricRegistry();
        useRegistry(registry);
        resetPublishedSignals();
    });

    afterEach(() => {
        useRegistry(null);
    });

    it('does not count one market disagreeing with another as a change', () => {
        // **This is the item.** One variable for the whole process: BTCUSDT
        // published LONG, then ETHUSDT published SHORT, and the counter went up —
        // while **neither** market had changed. The number that exists to answer
        // "how often does this market revise itself" was answering "how often do
        // two markets disagree", which is a fact about the deployment and about no
        // series at all.
        recordPublishedSignal('LONG', 'BTCUSDT');
        recordPublishedSignal('SHORT', 'ETHUSDT');

        expect(registry.value('signal_changes_total')).toBe(0);

        // Each market's first publication is not a change either, which is the
        // same rule the single variable used to get wrong in the other direction.
        recordPublishedSignal('LONG', 'BTCUSDT');

        expect(registry.value('signal_changes_total')).toBe(0);

        // Now BTCUSDT really does flip.
        recordPublishedSignal('SHORT', 'BTCUSDT');

        expect(registry.value('signal_changes_total')).toBe(1);
    });

    it('keeps the totals whole, because a label would make the name unreadable', () => {
        // Two markets, many publications, and the metric asked for by the name the
        // catalogue promises. A per-market series would answer `null` here for the
        // same reason `signal_changes_total{from,to}` once did: the reader asks for
        // a name and gets a series that does not exist under it.
        recordPublishedSignal('LONG', 'BTCUSDT');
        recordPublishedSignal('SHORT', 'BTCUSDT');
        recordPublishedSignal('NEUTRAL', 'ETHUSDT');
        recordPublishedSignal('NEUTRAL', 'ETHUSDT');

        expect(registry.value('signal_generation_total')).toBe(4);
        expect(registry.value('signal_changes_total')).toBe(1);
        expect(churnRate()).toBe(0.25);
    });

    it('reads the memory back per market', () => {
        recordPublishedSignal('LONG', 'BTCUSDT');
        recordPublishedSignal('SHORT', 'ETHUSDT');

        expect(lastPublishedSignal('BTCUSDT')).toBe('LONG');
        expect(lastPublishedSignal('ETHUSDT')).toBe('SHORT');
    });

    it('treats the same market in two spellings as one series', () => {
        // Normalised, because `btcusdt` and `BTCUSDT` arriving from two call sites
        // are the same market — and two entries would each believe they were the
        // first publication of a market nobody had seen, so the first real flip
        // would count as two changes or none.
        recordPublishedSignal('LONG', 'BTCUSDT');
        recordPublishedSignal('LONG', 'btcusdt');

        expect(registry.value('signal_changes_total')).toBe(0);

        recordPublishedSignal('SHORT', 'BtcUsdt');

        expect(registry.value('signal_changes_total')).toBe(1);
    });
});
