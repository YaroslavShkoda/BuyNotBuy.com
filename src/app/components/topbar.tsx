import Image from 'next/image';

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
    symbol: string;
    price: number;
    updatedAt: number;
}

export function Topbar({ symbol, price, updatedAt }: TopbarProps) {
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
                        BITCOIN INTELLIGENCE TERMINAL
                    </span>
                </div>
            </div>

            <div className="topbar-market">
                <span className="topbar-symbol">{symbol}</span>

                <span className="topbar-price">
                    ${price.toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                    })}
                </span>

                <span className="topbar-updated">
                    <span className="topbar-updated-dot" />
                    ОБНОВЛЕНО {formatUpdatedAt(updatedAt)}
                </span>
            </div>
        </header>
    );
}
