export default function MarketLoading() {
    return (
        <main className="app-shell" aria-busy="true">
            <div className="content-stack">
                <section className="state-card depth-surface">
                    <span className="eyebrow">ЗАГРУЗКА</span>

                    <h1>Загружаем данные рынка…</h1>
                </section>
            </div>
        </main>
    );
}
