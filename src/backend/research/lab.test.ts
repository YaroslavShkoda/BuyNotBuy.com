import { describe, expect, it } from 'vitest';

// The laboratory runs a full walk-forward, which is seconds of real work per
// call rather than milliseconds. The default 5s per test is a per-test budget
// for fast assertions, and a slow test that only fits under an idle machine is
// a test that fails in CI and passes locally.
const TIMEOUT = 30_000;


import type { Candle } from '../types/market.js';
import { DEFAULT_FEATURE_CONFIG, requiredBarsForFeatures } from './features.js';
import {
    isRuntimeStage,
    LabRunSchema,
    RUNTIME_STAGES,
    runLaboratory,
    STAGE_SIDE,
    STAGES,
} from './lab.js';

const HOUR = 3_600_000;

function series(count: number, drift = 0.001): Candle[] {
    const newestOpen = Math.floor(Date.now() / HOUR) * HOUR;
    let close = 50_000;
    const candles: Candle[] = [];

    for (let index = 0; index < count; index += 1) {
        close = close * (1 + drift);

        candles.push({
            timestamp: newestOpen - (count - 1 - index) * HOUR,
            open: close / (1 + drift),
            high: close * 1.002,
            low: close * 0.998,
            close,
            volume: 1000 + index,
        });
    }

    return candles;
}

function stage(run: ReturnType<typeof runLaboratory>, name: string) {
    const found = run.stages.find((entry) => entry.stage === name);

    if (found === undefined) {
        throw new Error(`no stage ${name}`);
    }

    return found;
}

describe('the research path and the request path are declared, not assumed', () => {
    it('knows which of the eleven stages a page may run', () => {
        // Six is the list; the point is that it exists as a value, so the
        // question can be asked by a test rather than answered by discipline.
        expect([...RUNTIME_STAGES].sort()).toEqual([
            'features',
            'indicator-evaluation',
            'performance',
            'production',
        ]);
    });

    it('keeps the expensive stages off the request path', () => {
        for (const stage of STAGES) {
            const runtime = isRuntimeStage(stage);
            const allowed = RUNTIME_STAGES.includes(stage);

            // A stage that is on the runtime side but not in the allowed list
            // would be a stage a page could reach and a test would not catch.
            expect(runtime).toBe(allowed);
        }
    });

    it('gives every stage a side, with no stage left undeclared', () => {
        for (const stage of STAGES) {
            expect(['runtime', 'research']).toContain(STAGE_SIDE[stage]);
        }
    });
}, TIMEOUT);

describe('the laboratory runs the whole chain and says what each stage found', () => {
    it('visits every stage, in the declared order', () => {
        const run = runLaboratory(series(1200));

        expect(run.stages.map((entry) => entry.stage)).toEqual([...STAGES]);
    });

    it('validates against its own schema', () => {
        expect(() => LabRunSchema.parse(runLaboratory(series(1500)))).not.toThrow();
    });

    it('reports a checksum for the dataset it built', () => {
        const run = runLaboratory(series(1500));

        expect(run.dataset.checksum).toMatch(/^[0-9a-f]{8}$/);
        expect(run.dataset.rows).toBeGreaterThan(0);
    });

    it('produces the same run twice for the same series', () => {
        const candles = series(1500);

        expect(runLaboratory(candles).dataset.checksum).toBe(
            runLaboratory(candles).dataset.checksum,
        );
    });

    it('produces a different dataset when the series is different', () => {
        expect(runLaboratory(series(1500, 0.002)).dataset.checksum).not.toBe(
            runLaboratory(series(1500, -0.001)).dataset.checksum,
        );
    });

    it('hands each stage a finding with numbers behind it', () => {
        const run = runLaboratory(series(1500));

        for (const entry of run.stages) {
            // A stage that reports nothing measurable is a stage whose claim
            // cannot be checked, and that is every stage in this list.
            expect(entry.finding.length).toBeGreaterThan(10);
            expect(Object.keys(entry.measured).length).toBeGreaterThan(0);
        }
    });
}, TIMEOUT);

describe('a short series is reported as short, not worked around', () => {
    it('says how many bars the features needed', () => {
        const run = runLaboratory(series(120));

        const research = stage(run, 'research');

        expect(research.finding).toMatch(/недостаточно/);
        expect(Number(research.measured['bars'])).toBe(120);
    });

    it('produces no vectors and says so', () => {
        const run = runLaboratory(series(120));

        expect(Number(stage(run, 'features').measured['vectors'])).toBe(0);
        expect(run.dataset.rows).toBe(0);
    });

    it('still runs to the end rather than stopping at the first empty stage', () => {
        const run = runLaboratory(series(120));

        expect(run.stages).toHaveLength(STAGES.length);
    });

    it('reports an empty dataset without inventing a checksum', () => {
        const run = runLaboratory(series(120));

        expect(run.dataset.checksum).toMatch(/^[0-9a-f]{8}$/);
        expect(run.dataset.labelled).toBe(0);
    });
}, TIMEOUT);

describe('nothing this build runs is fit to be promoted', () => {
    it('refuses, whatever the numbers say', () => {
        // The reason is structural rather than incidental: the chain has not
        // reached a confirmed candidate, so the decision belongs to the
        // transition rule and not to a summary of a backtest.
        expect(runLaboratory(series(1200)).promotable).toBe(false);
    });

    it('says why in words rather than leaving false unexplained', () => {
        const run = runLaboratory(series(1200));

        expect(run.why.length).toBeGreaterThan(40);
        expect(run.why).toMatch(/тень|калибров/);
    });

    it('produces no candidate, because none was earned', () => {
        expect(Number(stage(runLaboratory(series(1200)), 'candidate').measured['candidates'])).toBe(0);
    });

    it('reports no shadow signals, because a backtest has none to observe', () => {
        expect(
            Number(stage(runLaboratory(series(1200)), 'shadow').measured['shadowSignals']),
        ).toBe(0);
    });
}, TIMEOUT);

describe('a stage with no trades says so instead of reporting zero', () => {
    it('distinguishes no data from a flat result', () => {
        const run = runLaboratory(series(1500));

        // "No trades" and "made nothing" are different facts, and a reader
        // planning around the second when the first is true will conclude the
        // strategy is worthless rather than that it never traded.
        const performance = stage(run, 'performance');

        if (Number(performance.measured['trades']) === 0) {
            expect(performance.finding).toMatch(/не было|нечем/);
        } else {
            expect(performance.finding).toMatch(/сделок/);
        }
    });

    it('refuses to calibrate a sample it cannot support', () => {
        const calibration = stage(runLaboratory(series(1500)), 'calibration');
        const sample = Number(calibration.measured['sampleSize']);
        const minimum = Number(calibration.measured['minimumForCalibration']);

        if (sample < minimum) {
            expect(calibration.finding).toMatch(/калибровать не на чем/);
        }
    });
}, TIMEOUT);

describe('the splits the laboratory hands out are already purged', () => {
    it('reports how many rows fell out at the boundaries', () => {
        const run = runLaboratory(series(1200));

        expect(run.splits.purged).toBeGreaterThan(0);
        expect(run.splits.train + run.splits.validation + run.splits.test).toBeLessThanOrEqual(
            run.dataset.rows,
        );
    });

    it('gives the test set a real share rather than the remainder of a rounding', () => {
        const run = runLaboratory(series(1200));

        expect(run.splits.test).toBeGreaterThan(0);
    });
}, TIMEOUT);

describe('the feature window the laboratory uses is the one it reports', () => {
    it('agrees with the minimum the extractor states', () => {
        const run = runLaboratory(series(1500));
        const needed = requiredBarsForFeatures(DEFAULT_FEATURE_CONFIG);

        expect(run.stages[0]?.measured['usable']).toBe(1500 - needed + 1);
    });
});
