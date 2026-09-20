import { describe, expect, it } from "vitest";
import { calculateSignal } from "./signal.service";

describe("calculateSignal", () => {
    it('returns LONG when price is above EMA zone', () => {
        const result = calculateSignal(82000, {
            ema300: 78000,
        });

        expect(result.signal).toBe('LONG');
        expect(result.reason).toBe('Цена выше EMA 300');
    });

    it('returns SHORT when price is below EMA zone', () => {
        const result = calculateSignal(75000, {
            ema300: 78000,
        });

        expect(result.signal).toBe('SHORT');
        expect(result.reason).toBe('Цена ниже EMA 300');
    });

    it('returns NEUTRAL when price is inside EMA zone', () => {
        const result = calculateSignal(78000, {
            ema300: 78000,
        });

        expect(result.signal).toBe('NEUTRAL');
        expect(result.reason).toBe(
            'Цена находится на уровне EMA 300',
        );
    });

    it('returns NEUTRAL when price is slightly above EMA', () => {
        const result = calculateSignal(78200, {
            ema300: 78000,
        });

        expect(result.signal).toBe('NEUTRAL');
    });

    it('returns NEUTRAL when price is slightly below EMA', () => {
        const result = calculateSignal(77800, {
            ema300: 78000,
        });

        expect(result.signal).toBe('NEUTRAL');
    });
});