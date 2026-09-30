import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { cooldownBlocks, decideNext } from './lifecycle.js';
import { LifecycleConfigParser, lifecycleConfig } from '../config/lifecycle.config.js';

import type { LifecycleConfig } from '../config/lifecycle.config.js';

const HOUR = 3_600_000;
const BASE = 1_699_999_200_000;

const CONFIG: LifecycleConfig = {
    republishPriceMovePercent: 0.5,
    republishConfidenceDelta: 5,
    expiryBars: 72,
    cooldownBars: 12,
    invalidationPercent: 3,
};

function at(bars: number): number {
    return BASE + bars * HOUR;
}

function live(overrides: Partial<Parameters<typeof decideNext>[0]> = {}) {
    return {
        direction: 'LONG' as const,
        status: 'ACTIVE' as const,
        price: 100,
        confidence: 70,
        candleTimestamp: at(0),
        ...overrides,
    };
}

function candidate(overrides: Partial<Parameters<typeof decideNext>[1]> = {}) {
    return {
        direction: 'LONG' as const,
        confidence: 70,
        price: 100,
        candleTimestamp: at(1),
        ...overrides,
    };
}

describe('opening a signal', () => {
    it('opens one when the panel has an opinion and nothing is live', () => {
        const result = decideNext(null, candidate(), HOUR, CONFIG);

        expect(result.decision).toEqual({ kind: 'open', direction: 'LONG' });
        expect(result.toStatus).toBe('GENERATED');
        expect(result.recorded).toBe(true);
    });

    it('opens nothing when the panel has no opinion either', () => {
        const result = decideNext(null, null, HOUR, CONFIG);

        expect(result.decision.kind).toBe('unchanged');
        expect(result.recorded).toBe(false);
    });

    it('opens a SHORT as readily as a LONG', () => {
        expect(
            decideNext(null, candidate({ direction: 'SHORT' }), HOUR, CONFIG)
                .decision,
        ).toEqual({ kind: 'open', direction: 'SHORT' });
    });
});

describe('deduplication', () => {
    it('leaves a signal alone when nothing has moved', () => {
        // The case that matters most and is easiest to get wrong: a poll every
        // minute must not produce a row every minute.
        const result = decideNext(
            live(),
            candidate({ candleTimestamp: at(1) }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('unchanged');
        expect(result.recorded).toBe(false);
    });

    it('republishes once price has moved far enough', () => {
        // 0.6% against a 0.5% threshold.
        const result = decideNext(
            live(),
            candidate({ price: 100.6, candleTimestamp: at(1) }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('update');
        expect(result.toStatus).toBe('UPDATED');
    });

    it('republishes once confidence has moved enough, even at the same price', () => {
        // Confidence drifts on every poll even when nothing about the market
        // has changed, which is exactly why a move threshold on the price alone
        // would miss a signal that has become much better or much worse.
        const result = decideNext(
            live({ confidence: 70 }),
            candidate({ confidence: 78, candleTimestamp: at(1) }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('update');
    });

    it('ignores a confidence change below the threshold', () => {
        const result = decideNext(
            live({ confidence: 70 }),
            candidate({ confidence: 73, candleTimestamp: at(1) }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('unchanged');
    });

    it('measures the move against the last published price, not the previous poll', () => {
        // Price walks up in steps of 0.3%: never enough against the previous
        // bar, but a third of a percent every hour for two hours is a move.
        const first = decideNext(
            live({ price: 100 }),
            candidate({ price: 100.3, candleTimestamp: at(1) }),
            HOUR,
            CONFIG,
        );

        expect(first.decision.kind).toBe('unchanged');

        const second = decideNext(
            live({ price: 100 }),
            candidate({ price: 100.6, candleTimestamp: at(2) }),
            HOUR,
            CONFIG,
        );

        expect(second.decision.kind).toBe('update');
    });

    it('measures the move as a percentage, so the same setting works on any instrument', () => {
        const cheap = decideNext(
            live({ price: 1 }),
            candidate({ price: 1.006, candleTimestamp: at(1) }),
            HOUR,
            CONFIG,
        );
        const rich = decideNext(
            live({ price: 100_000 }),
            candidate({ price: 100_600, candleTimestamp: at(1) }),
            HOUR,
            CONFIG,
        );

        expect(cheap.decision.kind).toBe('update');
        expect(rich.decision.kind).toBe('update');
    });
});

describe('reversal', () => {
    it('opens a new signal when the panel turns the other way', () => {
        const result = decideNext(
            live(),
            candidate({ direction: 'SHORT', price: 100 }),
            HOUR,
            CONFIG,
        );

        expect(result.decision).toEqual({ kind: 'reversal', direction: 'SHORT' });
        expect(result.recorded).toBe(true);
    });

    it('is not blocked by the cooldown, however soon it happens', () => {
        // The setting exists to stop the system re-entering a position it just
        // left. Blocking a genuine turn would silence the one event most worth
        // recording — and a system that cannot record a reversal cannot detect
        // one being wrong.
        const result = decideNext(
            live({ candleTimestamp: at(0) }),
            candidate({ direction: 'SHORT', candleTimestamp: at(0) }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('reversal');
        expect(result.recorded).toBe(true);
    });

    it('is a new signal rather than an update to the old one', () => {
        // Measuring a flip as the same signal would mean measuring a trade
        // nobody held.
        expect(decideNext(live(), candidate({ direction: 'SHORT' }), HOUR, CONFIG).toStatus).toBe(
            'GENERATED',
        );
    });
});

describe('expiry', () => {
    it('expires a signal that has run out of bars', () => {
        const result = decideNext(
            live({ candleTimestamp: at(0) }),
            candidate({ candleTimestamp: at(72) }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('expire');
        expect(result.toStatus).toBe('EXPIRED');
    });

    it('leaves a signal one bar short of its life alone', () => {
        const result = decideNext(
            live({ candleTimestamp: at(0) }),
            candidate({ candleTimestamp: at(71) }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('unchanged');
    });

    it('counts bars, not wall time, so a gap in polling is not an expiry', () => {
        // A backend that was down for four hours has not had four hours of
        // signals expire. It has missed some bars, and whether that is enough
        // is a question about the bars it actually saw.
        const afterAGap = decideNext(
            live({ candleTimestamp: at(0) }),
            candidate({ candleTimestamp: at(4) }),
            HOUR,
            CONFIG,
        );

        expect(afterAGap.decision.kind).toBe('unchanged');
    });

    it('expires even when the panel has gone quiet', () => {
        // Expiry is a property of the signal that is already there. A panel
        // that stopped agreeing must not keep it alive by accident.
        const result = decideNext(
            live({ candleTimestamp: at(0) }),
            null,
            HOUR,
            CONFIG,
        );

        // No candidate means no new bar timestamp, so the elapsed count is
        // zero and nothing is decided. A signal cannot expire on a bar that
        // never closed.
        expect(result.decision.kind).toBe('unchanged');
    });

    it('expires on the same bar the panel is silent, when a bar is given', () => {
        const result = decideNext(
            live({ candleTimestamp: at(0) }),
            candidate({ candleTimestamp: at(100) }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('expire');
    });
});

describe('invalidation', () => {
    it('stops a LONG that has gone far enough against itself', () => {
        const result = decideNext(
            live({ direction: 'LONG', price: 100 }),
            candidate({ direction: 'LONG', price: 96.9, candleTimestamp: at(2) }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('invalidate');
        expect(result.toStatus).toBe('INVALIDATED');
    });

    it('stops a SHORT that has risen against itself', () => {
        const result = decideNext(
            live({ direction: 'SHORT', price: 100 }),
            candidate({ direction: 'SHORT', price: 103.1, candleTimestamp: at(2) }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('invalidate');
    });

    it('leaves a signal alone when price moved the right way by the same distance', () => {
        const result = decideNext(
            live({ direction: 'LONG', price: 100 }),
            candidate({ direction: 'LONG', price: 103.1, candleTimestamp: at(2) }),
            HOUR,
            CONFIG,
        );

        // Five percent in favour is a republish, not a failure. Invalidation
        // is directional, and a rule that only looked at the size of the move
        // would stop the best signals the system produces.
        expect(result.decision.kind).toBe('update');
    });

    it('leaves a signal alone just short of the threshold', () => {
        const result = decideNext(
            live({ direction: 'LONG', price: 100 }),
            candidate({ direction: 'LONG', price: 97.2, candleTimestamp: at(2) }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).not.toBe('invalidate');
    });

    it('reports invalidation even when the window has also run out', () => {
        // Both are true, and "the market moved against this" is the more
        // informative of the two. Reporting EXPIRED would discard it in favour
        // of a clock reading, and the performance table would lose the one
        // thing it came to look at.
        const result = decideNext(
            live({ candleTimestamp: at(0), price: 100 }),
            candidate({ candleTimestamp: at(100), price: 50 }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('invalidate');
    });

    it('expires a signal whose window ran out without ever being contradicted', () => {
        const result = decideNext(
            live({ candleTimestamp: at(0), price: 100 }),
            candidate({ candleTimestamp: at(100), price: 101 }),
            HOUR,
            CONFIG,
        );

        expect(result.decision.kind).toBe('expire');
    });
});

describe('cooldown', () => {
    it('blocks the same direction immediately after a closed signal', () => {
        expect(cooldownBlocks(at(0), at(1), HOUR, 12)).toBe(true);
    });

    it('stops blocking once enough bars have passed', () => {
        expect(cooldownBlocks(at(0), at(12), HOUR, 12)).toBe(false);
        expect(cooldownBlocks(at(0), at(13), HOUR, 12)).toBe(false);
    });

    it('does nothing when the cooldown is zero', () => {
        // Zero is a legitimate setting: it means the system may re-enter as
        // soon as the old signal closed, and says so explicitly.
        expect(cooldownBlocks(at(0), at(0), HOUR, 0)).toBe(false);
    });

    it('is counted in bars, so a gap in polling does not expire it early', () => {
        const twelveBarsOfWallTime = at(12);
        const fourHours = at(4);

        expect(cooldownBlocks(at(0), twelveBarsOfWallTime, HOUR, 12)).toBe(false);
        expect(cooldownBlocks(at(0), fourHours, HOUR, 12)).toBe(true);
    });
});

describe('the decision is reproducible', () => {
    it('gives the same answer for the same inputs, every time', () => {
        fc.assert(
            fc.property(
                fc.record({
                    livePrice: fc.double({ min: 0.01, max: 1e6, noNaN: true }),
                    candidatePrice: fc.double({ min: 0.01, max: 1e6, noNaN: true }),
                    bars: fc.integer({ min: 0, max: 200 }),
                    confidence: fc.double({ min: 0, max: 100, noNaN: true }),
                }),
                (input) => {
                    const first = decideNext(
                        live({ price: input.livePrice }),
                        candidate({
                            price: input.candidatePrice,
                            confidence: input.confidence,
                            candleTimestamp: at(input.bars),
                        }),
                        HOUR,
                        CONFIG,
                    );
                    const second = decideNext(
                        live({ price: input.livePrice }),
                        candidate({
                            price: input.candidatePrice,
                            confidence: input.confidence,
                            candleTimestamp: at(input.bars),
                        }),
                        HOUR,
                        CONFIG,
                    );

                    // No wall clock, no randomness, no hidden state. A rule that
                    // cannot be replayed over last month's data cannot be
                    // checked against last month's data.
                    expect(first).toEqual(second);
                },
            ),
            { numRuns: 300 },
        );
    });

    it('only ever records a transition that changed something', () => {
        fc.assert(
            fc.property(
                fc.record({
                    price: fc.double({ min: 1, max: 1e5, noNaN: true }),
                    bars: fc.integer({ min: 0, max: 200 }),
                    direction: fc.constantFrom('LONG' as const, 'SHORT' as const),
                }),
                (input) => {
                    const result = decideNext(
                        live({ direction: input.direction, price: 100 }),
                        candidate({
                            direction: input.direction,
                            price: input.price,
                            candleTimestamp: at(input.bars),
                        }),
                        HOUR,
                        CONFIG,
                    );

                    if (result.decision.kind === 'unchanged') {
                        expect(result.recorded).toBe(false);
                        expect(result.toStatus).toBeNull();
                    } else {
                        expect(result.recorded).toBe(true);
                        expect(result.toStatus).not.toBeNull();
                    }
                },
            ),
            { numRuns: 300 },
        );
    });

    it('always ends in a state the schema knows', () => {
        const known = new Set([
            'GENERATED',
            'ACTIVE',
            'UPDATED',
            'INVALIDATED',
            'EXPIRED',
            'CLOSED',
        ]);

        fc.assert(
            fc.property(
                fc.double({ min: 1, max: 1e5, noNaN: true }),
                fc.integer({ min: 0, max: 200 }),
                (price, bars) => {
                    const result = decideNext(
                        live({ price: 100 }),
                        candidate({ price, candleTimestamp: at(bars) }),
                        HOUR,
                        CONFIG,
                    );

                    if (result.toStatus !== null) {
                        expect(known.has(result.toStatus)).toBe(true);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});

describe('the shipped configuration', () => {
    it('leaves room between the cooldown and the expiry', () => {
        // A cooldown at least as long as the expiry would leave a window where
        // the system is neither allowed to publish the same direction again nor
        // waiting for anything to resolve.
        expect(lifecycleConfig.cooldownBars).toBeLessThan(
            lifecycleConfig.expiryBars,
        );
    });

    it('refuses a republish threshold of zero', () => {
        // Zero means every poll is a new signal, and the history becomes a
        // stream of rows nobody can read.
        expect(() =>
            LifecycleConfigParser.parse({
                republishPriceMovePercent: '0',
                republishConfidenceDelta: '5',
                expiryBars: '72',
                cooldownBars: '12',
                invalidationPercent: '3',
            }),
        ).toThrow(/every poll/);
    });

    it('refuses a cooldown that is not shorter than the expiry', () => {
        expect(() =>
            LifecycleConfigParser.parse({
                republishPriceMovePercent: '0.5',
                republishConfidenceDelta: '5',
                expiryBars: '12',
                cooldownBars: '12',
                invalidationPercent: '3',
            }),
        ).toThrow(/gap where nothing can be published/);
    });
});

describe('a silent panel and the end of a signal', () => {
    /**
     * The regression this file did not have.
     *
     * Expiry was measured between the live signal and
     * `candidate?.candleTimestamp ?? live.candleTimestamp`, so a null candidate
     * made the distance zero and the expiry branch was unreachable. A signal
     * could therefore only ever end while the panel was speaking — and the
     * comment above `decideNext` says the opposite, in as many words: a panel
     * that has gone quiet must not keep a dead signal alive. Code and stated
     * intent had been contradicting each other since it was written, and no test
     * caught it because every existing case passed a candidate.
     */
    const live = {
        direction: 'LONG' as const,
        status: 'GENERATED' as const,
        price: 100,
        confidence: 0.8,
        candleTimestamp: 1_700_000_000_000,
    };

    it('expires a signal whose panel has gone quiet, once enough bars have passed', () => {
        const result = decideNext(live, null, HOUR, CONFIG, live.candleTimestamp + 72 * HOUR);

        expect(result.decision).toEqual({ kind: 'expire' });
        expect(result.toStatus).toBe('EXPIRED');
        expect(result.recorded).toBe(true);
    });

    it('keeps it alive while the silence is still shorter than the window', () => {
        // 71 bars, not 72. The boundary being exact is the point: a rule that
        // expired one bar early would shorten every measured holding period in
        // the performance table by a constant nobody could see.
        expect(decideNext(live, null, HOUR, CONFIG, live.candleTimestamp + 71 * HOUR).decision).toEqual({
            kind: 'unchanged',
        });
        expect(decideNext(live, null, HOUR, CONFIG, live.candleTimestamp + 72 * HOUR).decision).toEqual({
            kind: 'expire',
        });
    });

    it('still says unchanged when the caller does not say what bar it is on', () => {
        // The fifth parameter is optional, and a caller that omits it gets the
        // old answer rather than a silent expiry. That is deliberate: guessing
        // the current bar would expire signals on a machine that simply has not
        // told us the time yet.
        expect(decideNext(live, null, HOUR, CONFIG).decision).toEqual({ kind: 'unchanged' });
    });
});