import { describe, expect, it } from 'vitest';

import {
    evaluateHoldout,
    HOLDOUT_COMMITTED_AT,
    HOLDOUT_MINIMUM_BARS,
    holdoutStatus,
    registerForEvaluation,
} from './holdout.js';

import type { Candle } from '../types/market.js';

const fingerprint = (key: string): string => `fp-${key}`;

function liveCandles(count: number): Candle[] {
    return Array.from({ length: count }, (_, index) => ({
        timestamp: HOLDOUT_COMMITTED_AT + index * 86_400_000,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
    }));
}

describe('the window that has not been opened', () => {
    it('is not ready before enough bars exist, and says so', () => {
        const status = holdoutStatus(liveCandles(HOLDOUT_MINIMUM_BARS - 1), []);

        expect(status.ready).toBe(false);
        expect(status.barsAvailable).toBe(HOLDOUT_MINIMUM_BARS - 1);
        expect(status.message).toContain('выдумка');
    });

    it('counts only bars from after the commitment', () => {
        // Everything before the date is development data, however much of it
        // there is. Counting it would make the window look full the day after
        // the promise was made.
        const history = Array.from({ length: 5000 }, (_, index) => ({
            timestamp: HOLDOUT_COMMITTED_AT - (5000 - index) * 86_400_000,
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
        }));

        const status = holdoutStatus([...history, ...liveCandles(10)], []);

        expect(status.barsAvailable).toBe(10);
        expect(status.ready).toBe(false);
    });

    it('is ready once the bars are there', () => {
        const status = holdoutStatus(liveCandles(HOLDOUT_MINIMUM_BARS), []);

        expect(status.ready).toBe(true);
        expect(status.barsAvailable).toBe(HOLDOUT_MINIMUM_BARS);
    });
});

describe('reading the window', () => {
    it('is refused while the window is empty', () => {
        const status = holdoutStatus(liveCandles(3), [registerForEvaluation('a', 'fp-a', 'why')]);

        expect(() => evaluateHoldout(status, fingerprint)).toThrow(status.message);
    });

    it('reports a rule that was adjusted afterwards as changed, not as failed', () => {
        // The distinction the whole apparatus rests on. "We predicted and were
        // wrong" and "we looked again and adjusted" are not the same sentence,
        // and a report that cannot tell them apart cannot be believed.
        const status = holdoutStatus(
            liveCandles(HOLDOUT_MINIMUM_BARS),
            [
                registerForEvaluation('untouched', 'fp-untouched', 'as frozen'),
                registerForEvaluation('adjusted', 'fp-adjusted', 'as frozen'),
            ],
        );

        const read = evaluateHoldout(
            status,
            (key) => (key === 'adjusted' ? 'fp-changed-after-registration' : `fp-${key}`),
        );

        expect(read).toHaveLength(2);
        expect(read.find((row) => row.candidate.key === 'untouched')!.changed).toBe(false);
        expect(read.find((row) => row.candidate.key === 'adjusted')!.changed).toBe(true);
    });

    it('keeps the evidence attached to the registration', () => {
        const candidate = registerForEvaluation(
            'donchian-20',
            'fp-1',
            'Плато 14—24, перелом по комиссии между 0.10% и 0.20%.',
            HOLDOUT_COMMITTED_AT,
        );

        expect(candidate.registeredAt).toBe(HOLDOUT_COMMITTED_AT);
        expect(candidate.note).toContain('перелом');
        expect(candidate.fingerprint).toBe('fp-1');
    });
});
