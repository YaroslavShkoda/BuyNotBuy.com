import Image from 'next/image';

interface TopbarProps {
    symbol: string;
    price: number;
}

export function Topbar({ symbol, price }: TopbarProps) {
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

                <span className="topbar-live">
                    <span className="topbar-live-dot" />
                    LIVE
                </span>
            </div>
        </header>
    );
}
