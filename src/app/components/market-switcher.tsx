'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface MarketOption {
    ticker: string;
    href: string;
    active: boolean;
    /** Base asset name from the registry ("Solana"); undefined when the registry cannot name it. */
    name?: string | undefined;
}

/**
 * Filters the switcher list by a free-form query.
 *
 * Kept out of the component so the matching rules are testable without a DOM:
 * a query matches the ticker or the registry name, case-insensitively, as a
 * substring — "sol" finds SOLUSDT and "sola" finds it by name. An empty or
 * blank query is the whole list, not an empty one.
 */
export function filterMarkets(
    markets: readonly MarketOption[],
    query: string,
): readonly MarketOption[] {
    const needle = query.trim().toLowerCase();

    if (needle === '') {
        return markets;
    }

    return markets.filter(
        (market) =>
            market.ticker.toLowerCase().includes(needle) ||
            (market.name ?? '').toLowerCase().includes(needle),
    );
}

export function MarketSwitcher({ markets }: { markets: readonly MarketOption[] }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const rootRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const toggleRef = useRef<HTMLButtonElement>(null);

    const current = markets.find((market) => market.active) ?? null;
    const results = useMemo(() => filterMarkets(markets, query), [markets, query]);

    // Outside click and Escape are the two ways a dropdown closes that a test
    // cannot see in the filter, so they live here rather than in the helpers.
    useEffect(() => {
        if (!open) {
            return;
        }

        const onPointerDown = (event: PointerEvent) => {
            if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false);
                toggleRef.current?.focus();
            }
        };

        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);

        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    useEffect(() => {
        if (open) {
            inputRef.current?.focus();
        } else {
            setQuery('');
        }
    }, [open]);

    if (markets.length === 0) {
        return null;
    }

    return (
        <div className="topbar-switcher" ref={rootRef}>
            <button
                ref={toggleRef}
                type="button"
                className={
                    current === null
                        ? 'topbar-switcher-toggle'
                        : 'topbar-switcher-toggle is-active'
                }
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
            >
                {current === null ? 'РЫНКИ' : current.ticker}
                <svg
                    className="topbar-switcher-caret"
                    width="8"
                    height="5"
                    viewBox="0 0 8 5"
                    aria-hidden="true"
                >
                    <path d="M1 1l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
                </svg>
            </button>

            {open && (
                <div className="topbar-switcher-panel">
                    <input
                        ref={inputRef}
                        type="text"
                        className="topbar-switcher-search"
                        placeholder="Поиск рынка"
                        aria-label="Поиск рынка"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />

                    {results.length === 0 ? (
                        <p className="topbar-switcher-empty">
                            {query.trim() === ''
                                ? 'Список рынков пуст'
                                : `Ничего не найдено по «${query.trim()}»`}
                        </p>
                    ) : (
                        <ul className="topbar-switcher-list" role="listbox" aria-label="Рынки">
                            {results.map((market) => (
                                <li key={market.ticker} role="none">
                                    <Link
                                        role="option"
                                        aria-selected={market.active}
                                        href={market.href}
                                        className={
                                            market.active
                                                ? 'topbar-switcher-option is-active'
                                                : 'topbar-switcher-option'
                                        }
                                        aria-current={market.active ? 'page' : undefined}
                                        onClick={() => setOpen(false)}
                                    >
                                        <span className="topbar-switcher-ticker">
                                            {market.ticker}
                                        </span>
                                        {market.name !== undefined && (
                                            <span className="topbar-switcher-name">
                                                {market.name}
                                            </span>
                                        )}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
