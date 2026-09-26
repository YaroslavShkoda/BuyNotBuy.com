'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * How often the dashboard pulls a new reading while it is being watched.
 *
 * The backend caches market data for 60s, so a faster tick than this would
 * spend requests to be told the same price. A slower one would make a live
 * dashboard feel broken: the number on screen is the whole point of the page,
 * and a price that visibly changes while you watch it is what says "this is
 * the real market" rather than "this is a screenshot".
 */
export const REFRESH_INTERVAL_MS = 30_000;

export interface AutoRefreshOptions {
    /** Pulls a new reading. */
    refresh: () => void;
    intervalMs: number;
    /** Whether anyone is currently looking at the page. */
    isVisible: () => boolean;
    /** Subscribes to visibility changes; call the returned function to unsubscribe. */
    onVisibilityChange: (listener: () => void) => () => void;
}

/**
 * Starts the refresh timer and returns the function that stops it.
 *
 * The timing lives here rather than inside the component so it can be tested
 * without a DOM or React. What the timer does depends on two things that are
 * not visible from a test: a hidden tab should not spend requests, and a tab
 * that has just come back must refresh at once — the user has been looking at
 * a frozen number for however long they were away, and making them wait for
 * the next tick shows them that stale number for another half-minute.
 */
export function startAutoRefresh({
    refresh,
    intervalMs,
    isVisible,
    onVisibilityChange,
}: AutoRefreshOptions): () => void {
    const refreshIfVisible = () => {
        if (!isVisible()) {
            return;
        }

        refresh();
    };

    const timer = setInterval(refreshIfVisible, intervalMs);
    const unsubscribe = onVisibilityChange(refreshIfVisible);

    return () => {
        clearInterval(timer);
        unsubscribe();
    };
}

export function AutoRefresh({ intervalMs = REFRESH_INTERVAL_MS }: { intervalMs?: number }) {
    const router = useRouter();

    useEffect(
        () =>
            startAutoRefresh({
                refresh: () => {
                    router.refresh();
                },
                intervalMs,
                isVisible: () => document.visibilityState === 'visible',
                onVisibilityChange: (listener) => {
                    document.addEventListener('visibilitychange', listener);

                    return () => {
                        document.removeEventListener('visibilitychange', listener);
                    };
                },
            }),
        [intervalMs, router],
    );

    return null;
}
