export default function Home() {
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
        <strong>$104,281</strong>
        <small>BTC / USDT</small>
      </section>

      <div className="dashboard">
        <section className="card">
          <h2>Technical Analysis</h2>

          <div className="indicator">
            <span>EMA 300</span>
            <strong className="long">LONG</strong>
          </div>

          <div className="indicator">
            <span>Stochastic</span>
            <strong className="long">LONG</strong>
          </div>
        </section>

        <section className="card signal-card">
          <h2>Market Signal</h2>
          <strong className="signal">LONG</strong>
          <p>2 of 2 indicators are bullish</p>
        </section>
      </div>

      <section className="card news-card">
        <h2>Latest News</h2>

        <article>
          <span>+</span>
          <p>Bitcoin market remains active</p>
        </article>

        <article>
          <span>+</span>
          <p>Institutional interest continues</p>
        </article>

        <article>
          <span>−</span>
          <p>Market volatility remains elevated</p>
        </article>
      </section>
    </main>
  );
}