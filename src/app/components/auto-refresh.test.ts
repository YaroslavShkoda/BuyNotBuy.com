import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REFRESH_INTERVAL_MS, startAutoRefresh } from './auto-refresh';

import type { AutoRefreshOptions } from './auto-refresh';

describe('dashboard auto refresh', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * Builds a driver with a visibility switch and a listener list, so a test
     * can flip the tab the way a browser does.
     */
    function setup(overrides: Partial<AutoRefreshOptions> = {}) {
        const refresh = vi.fn();
        const listeners = new Set<() => void>();
        let visible = true;

        const stop = startAutoRefresh({
            refresh,
            intervalMs: 30_000,
            isVisible: () => visible,
            onVisibilityChange: (listener) => {
                listeners.add(listener);

                return () => listeners.delete(listener);
            },
            ...overrides,
        });

        return {
            refresh,
            stop,
            /** Flips the tab and notifies the way `visibilitychange` would. */
            setVisible(next: boolean) {
                visible = next;

                for (const listener of listeners) {
                    listener();
                }
            },
            listenerCount: () => listeners.size,
        };
    }

    it('defaults to a 30 second interval', () => {
        expect(REFRESH_INTERVAL_MS).toBe(30_000);
    });

    it('refreshes on every tick while the page is being watched', () => {
        const { refresh, stop } = setup();

        vi.advanceTimersByTime(30_000);
        expect(refresh).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(30_000);
        expect(refresh).toHaveBeenCalledTimes(2);

        vi.advanceTimersByTime(30_000);
        expect(refresh).toHaveBeenCalledTimes(3);

        stop();
    });

    it('leaves the page alone until the interval has actually elapsed', () => {
        const { refresh, stop } = setup();

        vi.advanceTimersByTime(29_999);

        expect(refresh).not.toHaveBeenCalled();

        stop();
    });

    it('spends nothing while the tab is hidden', () => {
        // A tab nobody is looking at still burns a request per tick, and the
        // reading it would get is one nobody sees.
        const { refresh, setVisible, stop } = setup();

        setVisible(false);
        vi.advanceTimersByTime(30_000 * 5);

        expect(refresh).not.toHaveBeenCalled();

        stop();
    });

    it('refreshes at once when the tab comes back, rather than at the next tick', () => {
        // The user has been away looking at a frozen number. Waiting half a
        // minute more to replace it is the moment the page looks broken.
        const { refresh, setVisible, stop } = setup();

        setVisible(false);
        vi.advanceTimersByTime(30_000 * 3);

        setVisible(true);

        expect(refresh).toHaveBeenCalledTimes(1);

        stop();
    });

    it('ignores a visibility change that leaves the tab hidden', () => {
        const { refresh, setVisible, stop } = setup();

        setVisible(false);
        setVisible(false);

        expect(refresh).not.toHaveBeenCalled();

        stop();
    });

    it('stops refreshing once the component is gone', () => {
        // Without this, a closed tab would keep the timer alive and keep
        // refreshing a page nobody is looking at any more.
        const { refresh, stop } = setup();

        stop();
        vi.advanceTimersByTime(30_000 * 10);

        expect(refresh).not.toHaveBeenCalled();
    });

    it('unsubscribes from visibility changes on teardown', () => {
        const { stop, listenerCount, setVisible } = setup();

        expect(listenerCount()).toBe(1);

        stop();

        expect(listenerCount()).toBe(0);
        setVisible(true);
    });
});
