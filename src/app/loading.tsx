export default function DashboardLoading() {
    return (
        <main className="app-shell" aria-busy="true" aria-label="Загрузка данных рынка">
            <div className="state-card depth-surface">
                <span className="eyebrow">MARKET OVERVIEW</span>

                <h1>Загрузка данных рынка…</h1>

                <p>
                    Получаем актуальные котировки и технические индикаторы.
                </p>
            </div>
        </main>
    );
}
