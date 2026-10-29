'use client';

import { useRouter } from 'next/navigation';

export function retryVia(refresh: () => void): () => void {
    return () => refresh();
}

export function RetryButton({ label = 'Попробовать снова' }: { label?: string }) {
    const router = useRouter();

    return (
        <button
            type="button"
            className="state-retry"
            onClick={retryVia(() => router.refresh())}
        >
            {label}
        </button>
    );
}
