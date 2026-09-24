'use client';

import { useEffect } from 'react';

interface DashboardErrorProps {
    error: Error & { digest?: string };
    reset: () => void;
}

export default function DashboardError({ error, reset }: DashboardErrorProps) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return (
        <main className="app-shell">
            <div className="state-card depth-surface" role="alert">
                <span className="eyebrow">MARKET DATA UNAVAILABLE</span>

                <h1>Данные рынка временно недоступны</h1>

                <p>
                    Не удалось загрузить актуальные данные рынка.
                    Проверьте соединение и попробуйте ещё раз.
                </p>

                <button
                    type="button"
                    className="state-retry"
                    onClick={reset}
                >
                    Попробовать снова
                </button>
            </div>
        </main>
    );
}
