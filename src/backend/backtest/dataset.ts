import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * What a dataset is, and how to tell that it is the same one.
 *
 * A backtest result is a claim about a body of data. Without the identity of
 * that data the claim cannot be checked: a number from six months ago, on a
 * CSV somebody has since edited, describes a run nobody can repeat. The
 * checksum is what makes the claim falsifiable, and the manifest is what makes
 * the number legible without the original file being present.
 *
 * The checksum covers the candles *as they were read*, including the byte order
 * they arrived in. Sorting them first would be tidier and would be wrong: it
 * would mean two datasets that genuinely differ — one sorted, one not — hash
 * the same, and the difference between them is exactly the kind that changes a
 * result.
 */

const CandleSchema = z.object({
    timestamp: z.coerce.number(),
    open: z.coerce.number(),
    high: z.coerce.number(),
    low: z.coerce.number(),
    close: z.coerce.number(),
    volume: z.coerce.number().optional(),
});

export type Candle = z.infer<typeof CandleSchema>;

export const DatasetSchema = z.object({
    /** Stable name: what it is, not where it lives. */
    name: z.string().min(1),
    symbol: z.string().min(1),
    provider: z.string().min(1),
    interval: z.string().min(1),
    from: z.coerce.number(),
    to: z.coerce.number(),
    bars: z.coerce.number().int().nonnegative(),
    /**
     * Hash of the canonical text form of the bars.
     *
     * Not of the file. A file's hash changes when a line ending does, and the
     * data does not, so a file hash makes a dataset look modified when nothing
     * was — and the first thing anyone does with a manifest that says
     * "modified" is to stop trusting it.
     */
    checksum: z.string().min(1),
    recordedAt: z.coerce.number().int(),
});

export type Dataset = z.infer<typeof DatasetSchema>;

/**
 * The exact text a dataset's checksum is taken over.
 *
 * Exported, because a checksum nobody can reproduce is a checksum nobody can
 * check. A second implementation that produces the same string is a claim the
 * registry can be tested against.
 */
export function canonicalText(candles: readonly unknown[]): string {
    return candles
        .map((raw) => {
            const bar = CandleSchema.parse(raw);

            return [
                bar.timestamp,
                bar.open,
                bar.high,
                bar.low,
                bar.close,
                bar.volume ?? '',
            ].join(',');
        })
        .join('\n');
}

export function checksumCandles(candles: readonly unknown[]): string {
    return createHash('sha256').update(canonicalText(candles), 'utf8').digest('hex');
}

export interface DatasetInput {
    name: string;
    symbol: string;
    provider: string;
    interval: string;
    candles: readonly unknown[];
    /** Injected so a manifest is reproducible from the data alone. */
    recordedAt: number;
}

export function describeDataset(input: DatasetInput): Dataset {
    const first = input.candles[0];
    const last = input.candles[input.candles.length - 1];

    return DatasetSchema.parse({
        name: input.name,
        symbol: input.symbol,
        provider: input.provider,
        interval: input.interval,
        // An empty dataset has no span, and reporting 0..0 would imply a bar
        // at the epoch rather than the absence of bars.
        from: first === undefined ? 0 : CandleSchema.parse(first).timestamp,
        to: last === undefined ? 0 : CandleSchema.parse(last).timestamp,
        bars: input.candles.length,
        checksum: checksumCandles(input.candles),
        recordedAt: input.recordedAt,
    });
}

/**
 * Whether two descriptions are the same dataset.
 *
 * Compared on the parts that define the *data*, not on `name` or
 * `recordedAt`. The same bars downloaded twice from two sources is one dataset
 * recorded twice; the same name pointing at different bars is two datasets
 * sharing a label, and treating those as equal is how a "reproducible" result
 * quietly stops being reproducible.
 */
export function sameDataset(left: Dataset, right: Dataset): boolean {
    return (
        left.symbol === right.symbol &&
        left.provider === right.provider &&
        left.interval === right.interval &&
        left.from === right.from &&
        left.to === right.to &&
        left.bars === right.bars &&
        left.checksum === right.checksum
    );
}

export interface DatasetDifference {
    readonly field: string;
    readonly left: string | number;
    readonly right: string | number;
}

/**
 * What changed between two descriptions.
 *
 * Reports the fields, not just a boolean, because "these differ" leaves a
 * reader to guess whether the symbol changed or the data did, and the two
 * mean very different things for whether a result can be re-run.
 */
export function diffDatasets(
    left: Dataset,
    right: Dataset,
): DatasetDifference[] {
    const fields: (keyof Dataset)[] = [
        'name',
        'symbol',
        'provider',
        'interval',
        'from',
        'to',
        'bars',
        'checksum',
    ];

    return fields
        .filter((field) => left[field] !== right[field])
        .map((field) => ({ field, left: left[field], right: right[field] }));
}
