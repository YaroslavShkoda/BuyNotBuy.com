import Image from 'next/image';
import Link from 'next/link';

import { getAssetInfo } from '../lib/assets';

export function formatUpdatedAt(timestamp: number, now: Date = new Date()): string {
    // Guard against zero/negative timestamps: they would render a misleading
    // "ОБНОВЛЕНО 03:00" from 1970 epoch leftovers instead of an explicit absence marker.
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';

    const date = new Date(timestamp);

    // A stale snapshot must not look fresh: only same-day data shows bare HH:MM.
    const sameDay = date.toDateString() === now.toDateString();

    return sameDay
        ? date.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
        })
        : date.toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
}

export interface TopbarMarketLink {
    ticker: string;
    href: string;
    active: boolean;
}

interface TopbarProps {
    updatedAt: number;
    /** Symbol the current page is about; names the terminal subtitle. */
    assetName?: string;
    /** Active instruments for the switcher; absent when the registry is unreachable. */
    markets?: TopbarMarketLink[];
}

export function Topbar({ updatedAt, assetName, markets = [] }: TopbarProps) {
    const subject = assetName === undefined
        ? 'BITCOIN'
        : getAssetInfo(assetName).name.toUpperCase();

    return (
        <header className="topbar">
            <div className="topbar-brand">
                <div className="topbar-logo">
                    <Image
                        src="/BuyNotBuy.png"
                        alt="BuyNotBuy"
                        width={42}
                        height={42}
                        priority
                    />
                </div>

                <div className="topbar-brand-copy">
                    <span className="topbar-name">BuyNotBuy</span>
                    <span className="topbar-subtitle">
                        {subject} INTELLIGENCE TERMINAL
                    </span>
                </div>
            </div>

            {/* The pair and its price used to sit here, above the fold and
                separate from the asset they describe. The hero now carries both
                as one figure under the name, and a second copy in the bar read
                as a second quote. What is left is the brand and the only thing
                the bar says that the hero does not: how fresh the data is. */}
            <div className="topbar-market">
                {markets.length > 0 && (
                    <nav className="topbar-markets" aria-label="Рынки">
                        {markets.map((market) => (
                            <Link
                                key={market.ticker}
                                href={market.href}
                                className={
                                    market.active
                                        ? 'topbar-market-link is-active'
                                        : 'topbar-market-link'
                                }
                                aria-current={market.active ? 'page' : undefined}
                            >
                                {market.ticker}
                            </Link>
                        ))}
                    </nav>
                )}
                <span className="topbar-updated">
                    <span className="topbar-updated-dot" />
                    ОБНОВЛЕНО {formatUpdatedAt(updatedAt)}
                </span>
            </div>
        </header>
    );
}
