import { describe, expect, it } from 'vitest';

import { describeBackfill } from './backfill.report.js';

import type { BackfillResult } from './backfill.service.js';

const series = { provider: 'bitget', symbol: 'BTCUSDT', interval: '1d' };

function result(over: Partial<BackfillResult> = {}): BackfillResult {
    return {
        written: 500,
        overwritten: 0,
        pages: 5,
        oldestStored: 1_600_000_000_000,
        done: true,
        rejected: 2,
        reason: 'target_reached',
        total: 1_500,
        ...over,
    };
}

/**
 * The one number that has to be visible.
 *
 * `bulkUpsert` issues one `ON CONFLICT ... DO UPDATE` and returns a single
 * count, so filling a gap and replacing a stored bar look identical from the
 * write's side. They are not identical: the second one changes the inputs under
 * every signal, outcome and backtest already computed from those bars, and
 * nothing downstream would show it. The report is where that difference becomes
 * visible, so the tests are about it.
 */
describe('the backfill report separates filling from overwriting', () => {
    it('prints the two counts apart, not one total', () => {
        const text = describeBackfill({ result: result({ written: 500 }), series });

        expect(text).toContain('Записано всего: 500');
        expect(text).toContain('из них заполнено дыр: 500');
        expect(text).toContain('из них перезаписано уже хранившихся: 0');
    });

    it('warns in words when stored bars were overwritten', () => {
        const text = describeBackfill({
            result: result({ written: 500, overwritten: 300 }),
            series,
        });

        expect(text).toContain('из них заполнено дыр: 200');
        expect(text).toContain('из них перезаписано уже хранившихся: 300');
        expect(text).toContain('ВНИМАНИЕ');
        expect(text).toContain('была перезаписана');
    });

    it('stays quiet when nothing was overwritten', () => {
        // A warning printed on every clean run is a warning nobody reads by the
        // time a run actually needs it.
        const text = describeBackfill({ result: result({ overwritten: 0 }), series });

        expect(text).not.toContain('ВНИМАНИЕ');
    });

    it('cannot report more overwritten than written', () => {
        // The subtraction is guarded rather than trusted: a progress counter
        // that lost a race between pages would otherwise print "filled: -12"
        // and read as a number of holes rather than a bug.
        const text = describeBackfill({
            result: result({ written: 10, overwritten: 40 }),
            series,
        });

        expect(text).toContain('из них заполнено дыр: 0');
    });

    it('says why the run stopped', () => {
        // "0 written" and "0 written because the budget ran out" need different
        // reactions, and only one of them is fixed by running it again.
        expect(
            describeBackfill({ result: result({ reason: 'no_more_bars' }), series }),
        ).toContain('биржа больше не отдаёт более старых баров');

        expect(
            describeBackfill({ result: result({ reason: 'budget_exhausted' }), series }),
        ).toContain('исчерпан бюджет свечей');
    });

    it('reports an empty series as empty rather than as a bar in 1970', () => {
        const text = describeBackfill({
            result: result({ oldestStored: null, total: 0 }),
            series,
        });

        expect(text).toContain('Самый старый бар: нет');
    });
});
