import Image from 'next/image';

import { type MarketOption, MarketSwitcher } from './market-switcher';

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

interface TopbarProps {
    updatedAt: number;
    /** Display name of the current market, as the registry spells it; names the terminal subtitle. */
    assetName?: string;
    /** Active instruments for the switcher; absent when the registry is unreachable. */
    markets?: MarketOption[];
}

export function Topbar({ updatedAt, assetName, markets = [] }: TopbarProps) {
    // No hardcoded asset: an absent name means the registry has not spoken, and
    // the subtitle then says what is true ("INTELLIGENCE TERMINAL") rather than
    // what used to be true (that the only market was Bitcoin).
    const subject = assetName === undefined ? null : assetName.toUpperCase();

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
                        {subject === null ? 'INTELLIGENCE TERMINAL' : `${subject} INTELLIGENCE TERMINAL`}
                    </span>
                </div>
            </div>

            {/* The pair and its price used to sit here, above the fold and
                separate from the asset they describe. The hero now carries both
                as one figure under the name, and a second copy in the bar read
                as a second quote. What is left is the brand and the only thing
                the bar says that the hero does not: how fresh the data is. */}
            <div className="topbar-market">
                {/* A switcher, not a row of pills: the registry decides how many
                    markets exist, and a row that grows with it would push the
                    one thing this bar says (how fresh the data is) out of the
                    header. The search names the market the way the registry
                    does, so nothing here guesses. */}
                <MarketSwitcher markets={markets} />
                <span className="topbar-updated">
                    <span className="topbar-updated-dot" />
                    ОБНОВЛЕНО {formatUpdatedAt(updatedAt)}
                </span>
            </div>
        </header>
    );
}
