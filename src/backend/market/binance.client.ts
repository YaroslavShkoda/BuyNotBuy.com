import { z } from 'zod';
import type { BitcoinPrice, Candle } from '../types/market';

const BinancePriceSchema = z.object({
    symbol: z.string(),
    price: z.string(),
})

const BinanceCandleSchema = z.array(
    z.array(z.string().or(z.number()))
)

const BINANCE_BASE_URL = 'https://data-api.binance.vision';
const BTC_SYMBOL = 'BTCUSDT';
const CANDLE_INTERVAL = '1h';

export async function getBitcoinPrice(): Promise<BitcoinPrice> {
    const url = `${BINANCE_BASE_URL}/api/v3/ticker/price?symbol=${BTC_SYMBOL}`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Binance API error: ${response.status}`);
    }

    const data = await response.json();
    const validateData = BinancePriceSchema.parse(data);

    return {
        symbol: validateData.symbol,
        price: Number(validateData.price),
    };
}

export async function getBitcoinCandles(
    limit = 300,
): Promise<Candle[]> {
    const url = 
        `${BINANCE_BASE_URL}/api/v3/klines` +
        `?symbol=${BTC_SYMBOL}` +
        `&interval=${CANDLE_INTERVAL}` +
        `&limit=${limit}`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Binance API error: ${response.status}`);
    }

    const data = await response.json();
    const validateData = BinanceCandleSchema.parse(data);

    return validateData.map((candle) => ({
        timestamp: Number(candle[0]),
        open: Number(candle[1]),
        high: Number(candle[2]),
        low: Number(candle[3]),
        close: Number(candle[4]),
        volume: Number(candle[5]),
    }));
}