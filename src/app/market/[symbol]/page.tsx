import { notFound } from 'next/navigation';

import { Hero } from '../../components/hero';
import { Topbar } from '../../components/topbar';
import { AutoRefresh } from '../../components/auto-refresh';
import { getAnalysis } from '../../lib/analysis';
import { getMarket } from '../../lib/market';
import { getSignalHistory } from '../../lib/history';
import { getInstruments } from '../../lib/instruments';
import { MarketDetails } from '../../components/market-details';

export default async function MarketPage({
    params,
}: {
    params: Promise<{ symbol: string }>;
}) {
    const { symbol } = await params;
    const instrument = symbol.trim().toUpperCase();

    // The registry decides membership before any data request: a typo in the
    // URL must answer 404, not the provider's 502 for a market nobody serves.
    // A failed registry read degrades to "no verdict" and lets the data
    // requests decide, the same way the history request already degrades.
    const instruments = await getInstruments().catch(() => null);

    if (instruments !== null && !instruments.some((row) => row.ticker === instrument)) {
        notFound();
    }

    // Signal history is a non-critical request: if it fails, the dashboard
    // must still render and the history block shows an unavailable state.
    const [analysis, market, history] = await Promise.all([
        getAnalysis(instrument),
        getMarket(instrument),
        getSignalHistory(instrument).catch(() => null),
    ]);

    const marketLinks = (instruments ?? [])
        .filter((row) => row.status === 'active')
        .map((row) => ({
            ticker: row.ticker,
            href: `/market/${row.ticker}`,
            active: row.ticker === market.price.symbol,
        }));

    return (
        <main className="app-shell">
            {/* The page is server-rendered, so without this the price on screen
                is whatever it was at the moment the tab was opened, and stays
                there. */}
            <AutoRefresh />

            <Topbar
                updatedAt={analysis.timestamp}
                assetName={market.price.symbol}
                markets={marketLinks}
            />

            <div className="content-stack">
                <Hero
                    analysis={analysis}
                    history={history}
                    candles={market.candles}
                    symbol={market.price.symbol}
                    ema300={analysis.indicators.ema300}
                />
                <MarketDetails candles={market.candles} analysis={analysis} symbol={market.price.symbol} />
            </div>
        </main>
    );
}
