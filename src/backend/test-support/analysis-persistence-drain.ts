import { vi } from 'vitest';

// Keep the real persistence and its errors. Only give this test's app lifetime
// ownership of work that the production response intentionally does not await.
const persistenceWork = vi.hoisted(() => {
    const pending = new Set<Promise<unknown>>();
    return {
        track<T>(work: Promise<T>): Promise<T> {
            const tracked = work.finally(() => pending.delete(tracked));
            pending.add(tracked);
            return tracked;
        },
        async drain(): Promise<void> {
            // A completed stage can start another stage (version -> snapshot).
            // Observe all siblings even after rejection. Each returned promise
            // still delivers its original outcome to the production caller.
            while (pending.size > 0) await Promise.allSettled([...pending]);
        },
    };
});

vi.mock('../indicators/performance/indicator-performance.service.js', async (original) => {
    const real = await original<typeof import('../indicators/performance/indicator-performance.service.js')>();
    return {
        ...real,
        recordIndicatorVotes: (...args: Parameters<typeof real.recordIndicatorVotes>) => persistenceWork.track(real.recordIndicatorVotes(...args)),
        settleForwardReturns: (...args: Parameters<typeof real.settleForwardReturns>) => persistenceWork.track(real.settleForwardReturns(...args)),
    };
});

vi.mock('../services/analysis.persistence.js', async (original) => {
    const real = await original<typeof import('../services/analysis.persistence.js')>();
    return {
        ...real,
        recordStrategyDecisions: (...args: Parameters<typeof real.recordStrategyDecisions>) => persistenceWork.track(real.recordStrategyDecisions(...args)),
    };
});

vi.mock('../analysis/strategy-version.repository.js', async (original) => {
    const real = await original<typeof import('../analysis/strategy-version.repository.js')>();
    return {
        ...real,
        getStrategyVersionRepository: () => {
            const repository = real.getStrategyVersionRepository();
            return { ...repository, resolveActive: (...args: Parameters<typeof repository.resolveActive>) => persistenceWork.track(repository.resolveActive(...args)) };
        },
    };
});

vi.mock('../analysis/signal-snapshot.repository.js', async (original) => {
    const real = await original<typeof import('../analysis/signal-snapshot.repository.js')>();
    return {
        ...real,
        getSignalSnapshotRepository: () => {
            const repository = real.getSignalSnapshotRepository();
            return { ...repository, record: (...args: Parameters<typeof repository.record>) => persistenceWork.track(repository.record(...args)) };
        },
    };
});

export { persistenceWork as analysisPersistenceWork };
