/**
 * The backfill, rendered as text.
 *
 * Split from the command for the same reason as `optimize.report.ts`: a `main()`
 * at the bottom of a file runs when a test imports the reporter out of it, and
 * this report has to be checkable without opening a network connection and
 * walking a year of bars backwards.
 *
 * The shape is dictated by one question the operator actually has afterwards:
 * did this run fill gaps, or did it overwrite things that were already there?
 * Both write the same number of bars, `bulkUpsert` cannot tell them apart, and
 * only the second one changes the inputs under every measurement ever computed
 * from those bars. So the two are printed as two numbers, and a run that
 * overwrote more than it filled says so in words rather than leaving it to be
 * worked out from the total.
 */

import type { BackfillResult } from './backfill.service.js';

const STOP_REASONS: Record<BackfillResult['reason'], string> = {
    target_reached: 'достигнута запрошенная дата',
    no_more_bars: 'биржа больше не отдаёт более старых баров',
    budget_exhausted: 'исчерпан бюджет свечей',
};

export interface BackfillReportInput {
    readonly result: BackfillResult;
    readonly series: { provider: string; symbol: string; interval: string };
    readonly requested?: { until?: number; maxCandles?: number };
}

function bar(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
}

export function describeBackfill(input: BackfillReportInput): string {
    const { result, series } = input;
    const filled = Math.max(0, result.written - result.overwritten);

    const lines: string[] = [];

    lines.push('=== ЗАПОЛНЕНИЕ ИСТОРИИ ===');
    lines.push(
        `Ряд: ${series.symbol} ${series.interval} (площадка ${series.provider})`,
    );

    if (input.requested?.until !== undefined) {
        lines.push(`Запрошено до: ${bar(input.requested.until)}`);
    }

    if (input.requested?.maxCandles !== undefined) {
        lines.push(`Бюджет: ${input.requested.maxCandles} свечей`);
    }

    lines.push('');
    lines.push(`Записано всего: ${result.written}`);
    lines.push(`  из них заполнено дыр: ${filled}`);
    lines.push(`  из них перезаписано уже хранившихся: ${result.overwritten}`);

    if (result.overwritten > 0) {
        lines.push('');
        lines.push(
            'ВНИМАНИЕ: часть баров уже была в таблице и была перезаписана. ' +
                'Сигналы, исходы и бэктесты, посчитанные по этим барам, ' +
                'опираются на прежние значения — их выводы стоит перепроверить.',
        );
    }

    lines.push('');
    lines.push(`Отклонено проверкой: ${result.rejected}`);
    lines.push(`Страниц запрошено: ${result.pages}`);
    lines.push(`Всего в ряду теперь: ${result.total}`);
    lines.push(
        `Самый старый бар: ${result.oldestStored === null ? 'нет' : bar(result.oldestStored)}`,
    );
    lines.push(`Остановка: ${STOP_REASONS[result.reason]}`);

    return lines.join('\n');
}
