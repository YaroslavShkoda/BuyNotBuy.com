import { describe, expect, it, vi } from 'vitest';

vi.mock('../history/signal-history.service', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

describe('analyzeMarket with MockProvider', () => {
    it('builds complete analysis without Binance', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'mock');

        const {
            analyzeMarket,
        } = await import('./analysis.service');

        const result = await analyzeMarket();

        expect(result.price).toBe(100000);

        expect(result.indicators).toHaveProperty(
            'ema300',
        );

        expect(result.indicators).toHaveProperty(
            'stochastic',
        );

        expect(result.signal).toHaveProperty(
            'signal',
        );

        expect(result.signal).toHaveProperty(
            'confidence',
        );

        expect(result.signal).toHaveProperty(
            'reason',
        );

        expect(result.timestamp).toBeTypeOf('number');

        vi.unstubAllEnvs();
    });
});
