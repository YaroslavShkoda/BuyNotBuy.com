import { getAnalysis } from './lib/analysis';

export default async function Home() {
    const analysis = await getAnalysis();

    return (
        <main>
            <header className="header">
                <div className="brand">
                    <img
                        src="/BuyNotBuy.png"
                        alt="BuyNotBuy"
                        className="logo"
                    />

                    <div>
                        <h1>BuyNotBuy</h1>
                        <p>Bitcoin Analytics</p>
                    </div>
                </div>
            </header>

            <section className="price-card">
                <span>BITCOIN</span>
                <strong>{analysis.price.toLocaleString()}</strong>
                <small>BTC / USDT</small>
            </section>

            <div className="dashboard">
                <section className="card">
                    <h2>Technical Analysis</h2>

                    {analysis.signal.indicators.map((indicator) => (
                        <div className="indicator" key={indicator.name}>
                            <span>{indicator.name}</span>
                            <strong className={indicator.signal.toLowerCase()}>
                                {indicator.signal}
                            </strong>
                        </div>
                    ))}
                </section>

                <section className="card signal-card">
                    <h2>Market Signal</h2>
                    <strong className="signal">
                        {analysis.signal.signal}
                    </strong>
                    <p>{analysis.signal.reason}</p>
                    <p>Confidence: {analysis.signal.confidence}%</p>
                </section>
            </div>

            <section className="card news-card">
                <h2>Latest News</h2>

                <article>
                    <span>+</span>
                    <p>News integration coming soon</p>
                </article>
            </section>
        </main>
    );
}

