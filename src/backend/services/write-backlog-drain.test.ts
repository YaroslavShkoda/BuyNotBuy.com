import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFlushHistory, mockFlushVotes, mockFlushDecisions } = vi.hoisted(() => ({
    mockFlushHistory: vi.fn(async (): Promise<number> => 0),
    mockFlushVotes: vi.fn(async (): Promise<number> => 0),
    mockFlushDecisions: vi.fn(async (): Promise<number> => 0),
}));

vi.mock('../history/signal-history.service.js', () => ({
    flushSignalHistoryBacklog: mockFlushHistory,
}));

vi.mock('../indicators/performance/indicator-performance.service.js', () => ({
    flushIndicatorVoteBacklog: mockFlushVotes,
}));

vi.mock('./analysis.persistence.js', () => ({
    flushStrategyDecisionBacklog: mockFlushDecisions,
}));

import { drainPeriodicBacklogs } from './write-backlog-drain.js';

/**
 * Three write buffers, one cadence.
 *
 * The history buffer was flushed from inside the per-market cycle, once per
 * market. The vote buffer had no periodic flush at all — only on shutdown, and
 * when the buffer happened to fill. So a database blip parked history entries in a
 * buffer that got retried within the same tick and vote entries in one that waited
 * for the process to stop.
 *
 * Neither half was wrong on its own, which is why nothing caught it. The decision
 * journal joined last: it had no buffer to drain until the backlog existed.
 */
describe('the periodic write-buffer drain', () => {
    beforeEach(() => {
        mockFlushHistory.mockClear();
        mockFlushVotes.mockClear();
        mockFlushDecisions.mockClear();
        mockFlushHistory.mockResolvedValue(0);
        mockFlushVotes.mockResolvedValue(0);
        mockFlushDecisions.mockResolvedValue(0);
    });

    it('drains all three buffers, and returns what each flushed', async () => {
        mockFlushHistory.mockResolvedValue(3);
        mockFlushVotes.mockResolvedValue(1);
        mockFlushDecisions.mockResolvedValue(2);

        const drained = await drainPeriodicBacklogs();

        expect(drained).toEqual({ history: 3, votes: 1, decisions: 2 });
    });

    it('drains the vote buffer, which is the half that had no periodic flush', async () => {
        await drainPeriodicBacklogs();

        // **The item.** Before this, a vote sitting in the buffer after a database
        // blip stayed there until the buffer filled or the process stopped. A
        // buffered write is a write that has not happened yet, and the tick is the
        // soonest moment this process can be sure of anything.
        expect(mockFlushVotes).toHaveBeenCalledTimes(1);
    });

    it('drains the decision journal on the same tick as everything else', async () => {
        // A backlog that only drained at shutdown would hold the promotion
        // evidence hostage to the process lifetime: the row is a write that has
        // not happened yet, and the tick is the soonest moment anything can be
        // said about it.
        await drainPeriodicBacklogs();

        expect(mockFlushDecisions).toHaveBeenCalledTimes(1);
    });

    it('drains all three, not one — the asymmetry is what this function exists for', async () => {
        await drainPeriodicBacklogs();

        expect(mockFlushHistory).toHaveBeenCalledTimes(1);
        expect(mockFlushVotes).toHaveBeenCalledTimes(1);
        expect(mockFlushDecisions).toHaveBeenCalledTimes(1);
    });

    it('drains the vote buffer even when the history drain throws', async () => {
        // Sequential, not `Promise.all`: a buffer that throws must not take the
        // others down with it, because the one that throws is the one that
        // needs retrying. The shutdown path handles its failures explicitly; this
        // path is the steady state and has to keep going.
        mockFlushHistory.mockRejectedValue(new Error('statement timeout'));

        await drainPeriodicBacklogs().catch(() => undefined);

        expect(mockFlushVotes).toHaveBeenCalledTimes(1);
    });

    it('drains the decision journal even when the history drain throws', async () => {
        mockFlushHistory.mockRejectedValue(new Error('statement timeout'));

        await drainPeriodicBacklogs().catch(() => undefined);

        expect(mockFlushDecisions).toHaveBeenCalledTimes(1);
    });
});
