import { Hero } from './components/hero';
import { Topbar } from './components/topbar';
import { AutoRefresh } from './components/auto-refresh';
import { getAnalysis } from './lib/analysis';
import { getMarket } from './lib/market';
import { getSignalHistory } from './lib/history';
import { MarketDetails } from './components/market-details';

export default async function Home() {
    // Signal history is a non-critical request: if it fails, the dashboard
    // must still render and the history block shows an unavailable state.
    const [analysis, market, history] = await Promise.all([
        getAnalysis(),
        getMarket(),
        getSignalHistory().catch(() => null),
    ]);

    return (
        <main className="app-shell">
            {/* The page is server-rendered, so without this the price on screen
                is whatever it was at the moment the tab was opened, and stays
                there. */}
            <AutoRefresh />

            <Topbar
                symbol={market.price.symbol}
                price={market.price.price}
                updatedAt={analysis.timestamp}
            />

            <div className="content-stack">
                            <Hero
                                analysis={analysis}
                                history={history}
                                candles={market.candles}
                                symbol={market.price.symbol}
                                ema300={analysis.indicators.ema300}
                            />
                            <MarketDetails candles={market.candles} analysis={analysis} />
                        </div>
        </main>
    );
}
