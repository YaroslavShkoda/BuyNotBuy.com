import { redirect } from 'next/navigation';
import { defaultInstrumentTicker, getInstruments } from './lib/instruments';

export default async function Home() {
    const instruments = await getInstruments().catch(() => null);
    const ticker = instruments === null ? null : defaultInstrumentTicker(instruments);

    if (ticker !== null) {
        redirect(`/market/${encodeURIComponent(ticker)}`);
    }

    return (
        <main className="app-shell">
            <div className="state-card depth-surface" role="status">
                <span className="eyebrow">BUYNOTBUY</span>
                <h1>{instruments === null ? 'Список рынков недоступен' : 'Нет активных рынков'}</h1>
                <p>{instruments === null
                    ? 'Не удалось загрузить список рынков. Попробуйте обновить страницу.'
                    : 'Главная страница откроет первый активный рынок из реестра.'}</p>
            </div>
        </main>
    );
}
