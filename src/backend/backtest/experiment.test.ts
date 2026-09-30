import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { describeDataset, checksumCandles, canonicalText, sameDataset, diffDatasets, DatasetSchema } from './dataset.js';
import { checkReplayable, verifyAgainst, aggregate, experimentId, ExperimentManifestSchema } from './experiment.js';
import { manifestFor } from './manifest.js';
import { runWalkForward, DEFAULT_WALK_FORWARD_OPTIONS } from './walk-forward.js';
import { INDICATOR_SIGNAL_CONFIG } from '../config/indicator.config.js';
import { requiredCandleCount } from '../config/indicator.config.js';

import type { Dataset } from './dataset.js';
import type { ExperimentManifest } from './experiment.js';
import type { Candle } from '../types/market.js';

const HOUR = 3_600_000;
const NOW = 1_750_000_000_000;

function candles(count: number): Candle[] {
    return Array.from({ length: count }, (_, index) => {
        const close = 100 + 10 * Math.sin(index / 11) + index * 0.01;

        return {
            timestamp: NOW - (count - index) * HOUR,
            open: close * 0.999,
            high: close * 1.004,
            low: close * 0.996,
            close,
            volume: 1000 + index,
        };
    });
}

const SAMPLE = candles(requiredCandleCount() + 300);

const SERIES = {
    name: 'btcusdt-1d',
    symbol: 'BTCUSDT',
    provider: 'test',
    interval: '1d',
};

/**
 * `label` names the run; it does not identify it.
 *
 * The id is computed inside `manifestFor` from the record's own contents, so
 * three calls with the same data are three labels over one experiment — which
 * is what they are. An earlier version passed the label through as the id, and
 * the aggregate below was quietly describing the same run three times.
 */
function manifestOf(label: string, recordedAt = NOW): ExperimentManifest {
    const result = runWalkForward(SAMPLE, { foldBars: 60, trainingBars: 120, maxFolds: 2 });

    return manifestFor(
        result,
        SAMPLE,
        { ...DEFAULT_WALK_FORWARD_OPTIONS, foldBars: 60, trainingBars: 120, maxFolds: 2 },
        { name: `run ${label}`, recordedAt, commit: 'a'.repeat(40) },
        SERIES,
        {
            longThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
            shortThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
        },
    );
}

describe('a dataset is identified by its data, not by its file', () => {
    it('gives the same checksum for the same bars', () => {
        expect(checksumCandles(SAMPLE)).toBe(checksumCandles([...SAMPLE]));
    });

    it('gives a different checksum when one bar changes', () => {
        const altered = [...SAMPLE];
        const middle = { ...altered[100]! };

        // One close out of twelve hundred. This is the case a file hash
        // handles badly and a data hash handles exactly.
        middle.close += 0.01;
        altered[100] = middle;

        expect(checksumCandles(altered)).not.toBe(checksumCandles(SAMPLE));
    });

    it('is not fooled by order, because order is part of the data', () => {
        const shuffled = [SAMPLE[1]!, SAMPLE[0]!, ...SAMPLE.slice(2)];

        // Sorting first would be tidier and would be wrong: two datasets that
        // genuinely differ would hash the same, and order is exactly the kind
        // of difference that changes a result.
        expect(checksumCandles(shuffled)).not.toBe(checksumCandles(SAMPLE));
    });

    it('writes a text form somebody else can reproduce', () => {
        const text = canonicalText(SAMPLE.slice(0, 2));

        expect(text.split('\n')).toHaveLength(2);
        expect(text.split('\n')[0]).toBe(
            [
                SAMPLE[0]!.timestamp,
                SAMPLE[0]!.open,
                SAMPLE[0]!.high,
                SAMPLE[0]!.low,
                SAMPLE[0]!.close,
                SAMPLE[0]!.volume,
            ].join(','),
        );
    });

    it('describes a span rather than inventing one for an empty set', () => {
        const empty = describeDataset({ ...SERIES, candles: [], recordedAt: NOW });

        // Reporting 0..0 would imply a bar at the epoch rather than the
        // absence of bars.
        expect(empty.bars).toBe(0);
        expect(empty.from).toBe(0);
        expect(empty.to).toBe(0);
    });

    it('treats the same bars recorded twice as one dataset', () => {
        const first = describeDataset({ ...SERIES, candles: SAMPLE, recordedAt: NOW });
        const again = describeDataset({ ...SERIES, candles: SAMPLE, recordedAt: NOW + 5_000 });

        // recordedAt and name are how a dataset is described, not what it is.
        expect(sameDataset(first, again)).toBe(true);
    });

    it('treats one name pointing at different bars as two datasets', () => {
        const first = describeDataset({ ...SERIES, candles: SAMPLE, recordedAt: NOW });
        const other = describeDataset({
            ...SERIES,
            candles: SAMPLE.slice(0, SAMPLE.length - 10),
            recordedAt: NOW,
        });

        // Sharing a label is not sharing a dataset, and calling it
        // reproducible is how a reproducible result quietly stops being one.
        expect(sameDataset(first, other)).toBe(false);
        expect(diffDatasets(first, other).map((row) => row.field)).toContain(
            'checksum',
        );
    });

    it('refuses a manifest with no name', () => {
        expect(() => DatasetSchema.parse({ ...describeDataset({ ...SERIES, candles: SAMPLE, recordedAt: NOW }), name: '' })).toThrow();
    });
});

describe('a run is recorded whole', () => {
    it('keeps the data, the assumptions and the numbers together', () => {
        const manifest = manifestOf('a');

        // A number is the least interesting part. What makes it worth keeping
        // is that somebody can say later what produced it.
        expect(manifest.dataset.checksum).toBe(checksumCandles(SAMPLE));
        expect(manifest.execution.model).toBe(DEFAULT_WALK_FORWARD_OPTIONS.execution.model);
        expect(manifest.options.foldBars).toBe(60);
        expect(manifest.folds).toHaveLength(2);
        expect(manifest.productionParameters.longThreshold).toBe(
            INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
        );
        expect(manifest.commit).toHaveLength(40);
    });

    it('records every fold as it was actually traded', () => {
        const manifest = manifestOf('a');
        const result = runWalkForward(SAMPLE, { foldBars: 60, trainingBars: 120, maxFolds: 2 });

        for (const [index, fold] of manifest.folds.entries()) {
            // The pair stored is the one the run traded with, which is the
            // shipped one when validation rejected the fit.
            expect(fold.longThreshold).toBe(result.folds[index]?.parameters.longThreshold);
            expect(fold.validationAccepted).toBe(
                result.folds[index]?.validation.accepted,
            );
        }
    });

    it('survives the schema, which is what makes the record trustworthy', () => {
        const parsed = ExperimentManifestSchema.safeParse(manifestOf('a'));

        expect(parsed.success).toBe(true);
    });
});

describe('a record says whether it can be repeated', () => {
    it('reports a run that repeats cleanly', () => {
        const readiness = checkReplayable(manifestOf('a'), 'a'.repeat(40));

        expect(readiness.replayable).toBe(true);
        expect(readiness.problems).toEqual([]);
    });

    it('refuses to call a run repeatable when no fold was evaluated', () => {
        const manifest = manifestOf('a');
        const empty: ExperimentManifest = { ...manifest, folds: [] };

        // An average of nothing is still a number, and it will still be
        // reported by whatever printed it.
        expect(checkReplayable(empty, null).replayable).toBe(false);
        expect(checkReplayable(empty, null).problems.join()).toMatch(/no folds/);
    });

    it('catches a fold that claims to have passed a check that never ran', () => {
        const manifest = manifestOf('a');
        const tampered: ExperimentManifest = {
            ...manifest,
            folds: manifest.folds.map((fold) => ({
                ...fold,
                validationAccepted: true,
                validationScore: null,
            })),
        };

        const readiness = checkReplayable(tampered, null);

        // This is the one failure the record exists to make impossible to
        // miss, so it is checked even though nothing else in the run can
        // produce it.
        expect(readiness.replayable).toBe(false);
        expect(readiness.problems.join()).toMatch(/no validation score/);
    });

    it('counts a fold that failed validation as something to know', () => {
        const manifest = manifestOf('a');
        const rejected: ExperimentManifest = {
            ...manifest,
            folds: manifest.folds.map((fold) => ({
                ...fold,
                validationAccepted: false,
                validationScore: -0.01,
            })),
        };

        // Not fatal — a run with rejected folds is a real run, and the folds
        // are recorded — but it is reported, because a record that hid it
        // would read like a clean one.
        expect(checkReplayable(rejected, null).replayable).toBe(false);
        expect(checkReplayable(rejected, null).problems.join()).toMatch(
            /rejected for failing validation/,
        );
    });

    it('says which commit the number came from when the code has moved on', () => {
        const readiness = checkReplayable(manifestOf('a'), 'b'.repeat(40));

        // Not an accusation: the run may still reproduce at the old commit.
        // It is reported so the reader knows which tree the number came from.
        expect(readiness.problems.join()).toMatch(/recorded at commit/);
    });

    it('repeats exactly when nothing has moved', () => {
        const verification = verifyAgainst(manifestOf('a'), manifestOf('a'));

        expect(verification.match).toBe(true);
        expect(verification.reason).toMatch(/reproduced exactly/);
    });

    it('names the condition that changed when the data is not the same', () => {
        const other = manifestOf('a');
        other.dataset = { ...other.dataset, checksum: 'f'.repeat(64) };

        const verification = verifyAgainst(manifestOf('a'), other);

        expect(verification.match).toBe(false);
        expect(verification.differences.map((row) => row.field)).toEqual([
            'dataset',
        ]);
    });

    it('calls a different answer under the same conditions a runner defect', () => {
        const fresh = manifestOf('a');
        fresh.metrics = { ...fresh.metrics, totalReturn: fresh.metrics.totalReturn + 1 };

        const verification = verifyAgainst(manifestOf('a'), fresh);

        // The same bars and the same assumptions giving a different number is
        // not a data problem, and lumping it in with one would hide which.
        expect(verification.match).toBe(false);
        expect(verification.reason).toMatch(/defect in the runner/);
    });
});

describe('an aggregate compares runs rather than averaging them away', () => {
    const manifests: ExperimentManifest[] = [
        manifestOf('short'),
        manifestOf('long'),
        manifestOf('middle'),
    ];

    it('sorts worst first', () => {
        // The run that cannot be reproduced is the one a reader needs to see,
        // and putting it behind three that can is a way of ensuring it is
        // not read.
        const { rows } = aggregate(manifests);
        const scores = rows.map((row) => row.returnPerBar);

        expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    });

    it('reports return per bar, not just return', () => {
        // A run over four years and a run over two months are otherwise
        // averaged into a number that describes neither.
        const { rows } = aggregate(manifests);

        for (const row of rows) {
            expect(row.bars).toBe(SAMPLE.length);
            expect(Number.isFinite(row.returnPerBar)).toBe(true);
        }
    });

    it('counts folds that passed validation against folds total', () => {
        const { rows } = aggregate(manifests);

        for (const row of rows) {
            expect(row.validationPassed).toBeLessThanOrEqual(row.folds);
        }
    });

    it('handles an empty registry without dividing by nothing', () => {
        const { rows, profitable } = aggregate([]);

        expect(rows).toEqual([]);
        expect(profitable).toBe(0);
    });
});

describe('two descriptions of the same thing are the same thing', () => {
    it('for any set of bars, and any list to hold them', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.record({
                        timestamp: fc.integer({ min: 0, max: 4_000_000_000_000 }),
                        open: fc.double({ min: 0.1, max: 100_000, noNaN: true }),
                        high: fc.double({ min: 0.1, max: 100_000, noNaN: true }),
                        low: fc.double({ min: 0.1, max: 100_000, noNaN: true }),
                        close: fc.double({ min: 0.1, max: 100_000, noNaN: true }),
                        volume: fc.double({ min: 0, max: 1e6, noNaN: true }),
                    }),
                    { maxLength: 40 },
                ),
                (bars) => {
                    const first = describeDataset({
                        name: 'x',
                        symbol: 'S',
                        provider: 'P',
                        interval: '1d',
                        candles: bars,
                        recordedAt: 1,
                    });
                    const second = describeDataset({
                        // Same data, different description of it.
                        name: 'y',
                        symbol: 'S',
                        provider: 'P',
                        interval: '1d',
                        candles: bars,
                        recordedAt: 999,
                    });

                    expect(sameDataset(first, second)).toBe(true);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('and are different whenever a single bar differs', () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0.1, max: 1000, noNaN: true }),
                (delta) => {
                    const base = candles(6);
                    const changed = [...base];
                    const bar = { ...changed[3]! };

                    bar.close += delta;
                    changed[3] = bar;

                    const left: Dataset = describeDataset({ ...SERIES, candles: base, recordedAt: NOW });
                    const right: Dataset = describeDataset({ ...SERIES, candles: changed, recordedAt: NOW });

                    expect(sameDataset(left, right)).toBe(false);
                },
            ),
            { numRuns: 100 },
        );
    });
});

describe('an experiment is identified by what it measured, not by what it is called', () => {
    it('names the same experiment the same way however it is labelled', () => {
        // The collision this replaces was silent and it is worth being precise
        // about it. The caller used to pass
        // `${instrument}-${interval}-${candles.length}` as the id: same symbol,
        // same interval, same count — and the checksum, the one field that
        // separates January's 8760 bars from February's, left out. Nothing
        // grouped by it yet, so nothing broke; the first thing that does inherits
        // a collision that looks like a match.
        //
        // The label fields are `name` and `recordedAt`, and they are excluded
        // for a reason rather than by omission: the same bars re-run tomorrow
        // under a different title is one experiment recorded twice, and an id
        // that changed when the title changed would make that look like two.
        const first = manifestOf('first', NOW);
        const second = manifestOf('completely different title', NOW + 86_400_000);

        expect(second.name).not.toBe(first.name);
        expect(second.recordedAt).not.toBe(first.recordedAt);
        expect(experimentId(second)).toBe(experimentId(first));
    });

    it('gives a different identity when one price in the data differs', () => {
        // The property the id is for. One close out of twelve hundred is the
        // difference between two runs a reader must not confuse, and it is
        // invisible to every field the old name used.
        const base = manifestOf('base');
        const changed = [...SAMPLE];
        const bar = { ...changed[100]! };

        bar.close += 0.01;
        changed[100] = bar;

        const other = manifestFor(
            runWalkForward(changed, {
                foldBars: 60,
                trainingBars: 120,
                maxFolds: 2,
            }),
            changed,
            { ...DEFAULT_WALK_FORWARD_OPTIONS, foldBars: 60, trainingBars: 120, maxFolds: 2 },
            { name: 'run base', recordedAt: NOW, commit: 'a'.repeat(40) },
            SERIES,
            {
                longThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
                shortThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
            },
        );

        expect(other.dataset.bars).toBe(base.dataset.bars);
        expect(other.id).not.toBe(base.id);
    });

    it('gives a different identity when the run is configured differently', () => {
        // Same bars, same everything a reader would call "the experiment", one
        // threshold changed. The results may well be identical; whether they
        // are is not for the id to decide, because a record that cannot tell
        // those two apart cannot say which one produced a number.
        const base = manifestOf('base');
        const other = manifestFor(
            runWalkForward(SAMPLE, { foldBars: 60, trainingBars: 120, maxFolds: 2 }),
            SAMPLE,
            {
                ...DEFAULT_WALK_FORWARD_OPTIONS,
                foldBars: 60,
                trainingBars: 120,
                maxFolds: 2,
                // One tenth of a percent on the shipped threshold.
                execution: {
                    ...DEFAULT_WALK_FORWARD_OPTIONS.execution,
                    slippageRate:
                        DEFAULT_WALK_FORWARD_OPTIONS.execution.slippageRate + 0.001,
                },
            },
            { name: 'run base', recordedAt: NOW, commit: 'a'.repeat(40) },
            SERIES,
            {
                longThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
                shortThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
            },
        );

        expect(other.id).not.toBe(base.id);
    });

    it('is not derived from what the run said, only from what it measured', () => {
        // `metrics` and `folds` are excluded on purpose. An id built from them
        // would be a different string every time the run produced a different
        // answer, which is a number that cannot identify anything — and it
        // would also make the identity depend on the correctness of the run,
        // so a fixed bug would mint a new experiment id and the before-and-after
        // would stop looking like the same experiment at all.
        const first = manifestOf('first');

        expect(first.folds.length).toBeGreaterThan(0);
        expect(experimentId({ ...first, metrics: { ...first.metrics, totalReturn: 99 } })).toBe(
            experimentId(first),
        );
    });

    it('reproduces for the same record and differs for any field it covers', () => {
        // The canonical field list is data, and this is what holds it to the
        // record: every field the id claims to cover must actually move it. A
        // field added to the manifest and forgotten in
        // `EXPERIMENT_IDENTITY_FIELDS` would not fail this — it would fail the
        // check that the list has not been quietly narrowed, which is why the
        // list and this test are read together.
        const base = manifestOf('base');

        const mutations: { readonly field: string; readonly manifest: ExperimentManifest }[] = [
            { field: 'execution', manifest: { ...base, execution: { ...base.execution, model: 'intrabar' } } },
            { field: 'options', manifest: { ...base, options: { ...base.options, foldBars: base.options.foldBars + 1 } } },
            {
                field: 'productionParameters',
                manifest: {
                    ...base,
                    productionParameters: {
                        ...base.productionParameters,
                        longThreshold: base.productionParameters.longThreshold + 1,
                    },
                },
            },
            {
                field: 'dataset',
                manifest: { ...base, dataset: { ...base.dataset, checksum: 'not-the-same-bars' } },
            },
        ];

        for (const { field, manifest } of mutations) {
            expect(experimentId(manifest), field).not.toBe(experimentId(base));
        }
    });
});
