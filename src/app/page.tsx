import { Hero } from './components/hero';
import { Topbar } from './components/topbar';
import { getAnalysis } from './lib/analysis';
import { getMarket } from './lib/market';
import { MarketChart } from './components/market-chart';
import { MarketDetails } from './components/market-details';

export default async function Home() {
    const [analysis, market] = await Promise.all([
        getAnalysis(),
        getMarket(),
    ]);

    return (
        <main className="app-shell">
            <Topbar
                symbol={market.price.symbol}
                price={market.price.price}
                updatedAt={analysis.timestamp}
            />

            <div className="content-stack">
                <Hero analysis={analysis} />
                <MarketChart candles={market.candles} symbol={market.price.symbol} ema300={analysis.indicators.ema300} />
                <MarketDetails candles={market.candles} analysis={analysis} />
            </div>
        </main>
    );
}
