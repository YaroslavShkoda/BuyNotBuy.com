import { beforeEach, describe, expect, it, vi } from 'vitest';

import { METRIC_KIND, METRIC_NAMES } from '../observability/metrics.js';

import type { MarketAnalysis } from '../types/analysis.js';

/**
 * A swallowed write has to be visible from outside the process.
 *
 * `recordStrategyDecisions` catches every failure and increments a module-level
 * number. That number has no reader outside its own file: not a metric, not a
 * health probe, not a test. The project's own rule is written next to it — "a
 * silent failure is indistinguishable from a system that is working" — and the
 * counter it relies on for that rule is itself unobserved.
 *
 * So the failure is real and invisible at once: the decision-log table is the
 * evidence base for the promotion ladder, a dropped row is a dropped row, and
 * nothing outside the process can tell that the count moved.
 *
 * The fix is additive. A name is declared in the closed metric list, the existing
 * `catch` increments it, and the exposition grows one series. No stored row
 * changes meaning and no caller sees a new argument — which is why this was
 * recorded as an open question for a while and then turned out to need no
 * question at all.
 */
const { analyzeMarketWithStatus, resetStrategyDecisionWriteFailures } =
    await import('./analysis.service.js');
const marketService = await import('../market/market.service.js');
const decisionLog = await import('../strategies/decision-log.repository.js');
const { marketData, marketDataResult } = await import('../test-support/market-data.js');

const CANDLES = Array.from({ length: 900 }, (_, index) => ({
    timestamp: index,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
}));

/** The name the loss is reported under. Declared, so the check is on a list. */
const LOSS = 'strategy_decision_write_failures';

beforeEach(() => {
    resetStrategyDecisionWriteFailures();
    vi.spyOn(marketService, 'getMarketData').mockResolvedValue(
        marketDataResult(
            marketData(CANDLES, {
                price: { symbol: 'BTCUSDT', price: 100 },
                provider: 'binance',
            }),
        ),
    );
});

describe('a lost decision-log row is reported, not only counted', () => {
    it('names a metric that exists in the closed list', () => {
        // The first version asserted the counter was incremented and passed
        // against a counter nobody outside the file could read — which is the
        // whole defect. The declaration is what makes the count reachable.
        expect(METRIC_NAMES).toContain(LOSS);
    });

    it('is a counter, because a count is what it is', () => {
        expect(METRIC_KIND[LOSS]).toBe('counter');
    });

    it('and is declared at zero while nothing has been lost', async () => {
        const { renderMetrics } = await import('../api/lib/metrics.js');
        const line = renderMetrics()
            .split(String.fromCharCode(10))
            .find(
                (one) =>
                    !one.startsWith('#') &&
                    one.startsWith(`buynotbuy_${LOSS} `),
            );

        expect(line).toBeDefined();
        expect(Number(line!.split(' ').at(-1))).toBe(0);
    });

    it('and the swallowed failure moves it', async () => {
        vi.spyOn(decisionLog, 'getDecisionLogRepository').mockReturnValue({
            record: vi.fn(async () => {
                throw new Error('database is on fire');
            }),
        } as unknown as ReturnType<typeof decisionLog.getDecisionLogRepository>);

        // The analysis must still answer — that is the point of swallowing it.
        const { analysis } = await analyzeMarketWithStatus();

        expect(analysis.signal).toBeDefined();

        expect(await exposureOf(LOSS)).toBeGreaterThan(0);
    });
});

/**
 * The value a scraper would read, parsed out of the exposition.
 *
 * Not the registry's internals — the point is that the loss reaches the text an
 * operator scrapes — and not the name. The registry renders a declared series at
 * zero when nothing has touched it, so a test that only asks whether the name
 * appears passes against a metric that never moves. Asserting the name was
 * exactly that test, and a control proved it: with the increment deleted from the
 * `catch`, it stayed green.
 */
async function exposureOf(name: string): Promise<number> {
    const { renderMetrics } = await import('../api/lib/metrics.js');

    return vi.waitFor(() => {
        const rendered = renderMetrics();
        const line = rendered
            .split(String.fromCharCode(10))
            // Only a sample line. `# TYPE buynotbuy_<name> counter` starts with
            // the same prefix and parses to NaN, so the first version of this
            // read the type line, got NaN, compared it as greater than zero and
            // reported a metric that was silently working. A parser that matches
            // a prefix it did not mean to match is the same defect as a predicate
            // that matches a substring.
            .find(
                (one) =>
                    !one.startsWith('#') && one.startsWith(`buynotbuy_${name} `),
            );

        expect(line, `${name} never reached the exposition as a sample`).toBeDefined();

        const value = Number(line!.split(' ').at(-1));

        // Throwing is how `waitFor` retries, and the decision-log write is fire
        // and forget: the count moves a moment after the analysis has already
        // answered. Returning the number instead — which is what the first
        // version did — resolved on the first sample, while the count was still
        // zero, and reported a metric that had not failed yet as one that did not
        // move. Same shape as the predicate that matched a prefix it did not mean
        // to match: a check that cannot express "not yet" cannot wait.
        expect(value, `${name} has not moved yet`).toBeGreaterThan(0);

        return value;
    });
}

/** Kept so the unused import of MarketAnalysis cannot hide a real dependency. */
export type _Kept = MarketAnalysis | undefined;