import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { RetryButton, retryVia } from './retry-button';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: () => undefined }),
}));

describe('RetryButton', () => {
    it('renders an accessible retry button', () => {
        const html = renderToStaticMarkup(createElement(RetryButton));

        expect(html).toContain('type="button"');
        expect(html).toContain('state-retry');
        expect(html).toContain('Попробовать снова');
    });

    it('renders a custom label without losing the contract', () => {
        const html = renderToStaticMarkup(createElement(RetryButton, { label: 'Обновить' }));

        expect(html).toContain('Обновить');
        expect(html).not.toContain('Попробовать снова');
    });

    it('refreshes the router segment once per invocation', () => {
        const refresh = vi.fn();
        const onClick = retryVia(refresh);

        onClick();

        expect(refresh).toHaveBeenCalledTimes(1);
    });
});
