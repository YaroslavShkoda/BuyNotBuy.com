import { describe, expect, it } from 'vitest';
import { inputFingerprint } from '../analysis/signal-snapshot.repository.js';
import { hashValue } from '../config/strategy-fingerprint.js';
import type { Candle } from '../types/market.js';
import {
    checksumCandles,
    describeDataset,
    diffCandles,
    sameCandles,
} from './dataset.js';

const NOW = 1_700_000_000_000;

const candles: Candle[] = [
    { timestamp: 1_700_000_000_000, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
    { timestamp: 1_700_086_400_000, open: 100.5, high: 102, low: 100, close: 101, volume: 12 },
];

const dataset = describeDataset({
    name: 'две полосы',
    symbol: 'BTCUSDT',
    provider: 'binance',
    interval: '1d',
    candles,
    recordedAt: NOW,
});

/**
 * The seam of the evidence chain.
 *
 * A backtest measures bars; a signal snapshot records the bars it was decided
 * on. Both sides describe a dataset and both sides store a hash of it, and for
 * a long time it looked like the two could be compared. They cannot.
 *
 * `Dataset.checksum` is sha256 over a CSV rendering of the bars.
 * `signal_snapshot.candles_hash` is `hashValue` over an array of six-element
 * arrays. Measured on the two bars below they disagree — so a "replayable
 * experiment" could never be shown to have run on the same data a signal was
 * actually taken from, which is the one claim that chain rests on.
 *
 * The comparison below is built on what both sides genuinely store in plain
 * columns. It is weaker than a hash and it says so: same extent, same count,
 * and the contents unchecked.
 */
describe('a dataset and a snapshot taken from the same bars', () => {
    it('agrees on the extent both sides really store', () => {
        const fingerprint = inputFingerprint(
            'BTCUSDT',
            101,
            candles,
            7,
            'binance',
            '1d',
        );

        expect(
            sameCandles(dataset, {
                firstCandleTs: fingerprint.firstCandleTs,
                lastCandleTs: fingerprint.lastCandleTs,
                // The repository stores `candles.length` here, so the comparison
                // reads the same number the column holds.
                candleCount: candles.length,
            }),
        ).toBe(true);
    });

    it('names the difference when the window moved', () => {
        const moved = diffCandles(dataset, {
            firstCandleTs: dataset.from,
            lastCandleTs: dataset.to + 1,
            candleCount: dataset.bars,
        });

        expect(moved).toEqual([{ field: 'to', left: dataset.to, right: dataset.to + 1 }]);
    });

    it('says which snapshot candlesHash came from, and refuses to pretend otherwise', () => {
        // The honest limit of the check above, pinned so it cannot be forgotten.
        // These are the same two bars, and the two hashes do not match.
        const snapshotStyle = hashValue(
            candles.map((candle) => [
                candle.timestamp,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                candle.volume,
            ]),
        );

        expect(snapshotStyle).not.toBe(dataset.checksum);
        expect(checksumCandles(candles)).toBe(dataset.checksum);

        // And the reason they are left apart, in one assertion: `input_hash` is
        // derived from `candles_hash`, and the snapshot store is idempotent on
        // `input_hash`. Changing the formula would make identical input hash
        // differently after a deploy, so re-storing the same page load would
        // insert a second row instead of recognising the first.
        const fingerprint = inputFingerprint('BTCUSDT', 101, candles, 7, 'binance', '1d');

        expect(fingerprint.candlesHash).toBe(snapshotStyle);
        expect(fingerprint.inputHash).not.toBe(snapshotStyle);
    });

    it('fails when the count differs even though the window agrees', () => {
        // The bar-by-bar difference this check cannot see, shown as a limit
        // rather than pretended away: the extent and the count can match while
        // the contents do not, and until the hashes are reconciled nothing below
        // this line can say otherwise.
        const narrower = diffCandles(dataset, {
            firstCandleTs: dataset.from,
            lastCandleTs: dataset.to,
            candleCount: dataset.bars - 1,
        });

        expect(narrower).toEqual([{ field: 'bars', left: dataset.bars, right: dataset.bars - 1 }]);
        expect(
            sameCandles(dataset, {
                firstCandleTs: dataset.from,
                lastCandleTs: dataset.to,
                candleCount: dataset.bars - 1,
            }),
        ).toBe(false);
    });
});
