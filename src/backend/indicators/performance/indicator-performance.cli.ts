/**
 * Per-indicator accuracy from the stored votes.
 *
 *   npm run indicators
 *
 * A console command, like the backtest, for the same reason: these numbers
 * describe how the indicators behaved on past readings, and putting them in
 * the dashboard would invite a reader to treat a settled historical vote as a
 * live one.
 */
import { marketConfig } from '../../config/market.config.js';
import { getIndicatorVoteRepository } from './indicator-vote.repository.js';
import { summarizeIndicatorPerformance } from './indicator-performance.service.js';

import type { IndicatorPerformance } from './indicator-performance.types.js';

function percent(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
}

function row(performance: IndicatorPerformance): string {
    return [
        `  ${performance.indicator.padEnd(16)}`,
        `${performance.horizon.padEnd(4)}`,
        `выборок: ${String(performance.samples).padStart(5)}`,
        `верных: ${percent(performance.hitRate).padStart(8)}`,
        `среднее: ${percent(performance.averageReturn).padStart(8)}`,
        `разброс: ${percent(performance.worst)} … ${percent(performance.best)}`,
    ].join('  ');
}

async function main(): Promise<void> {
    const repository = getIndicatorVoteRepository();
    const stored = await repository.count(marketConfig.symbol);

    console.log(`Символ: ${marketConfig.symbol}, свечи ${marketConfig.candleInterval}`);
    console.log(`Сохранено голосов: ${stored}`);

    if (stored === 0) {
        console.log(
            'Голосов пока нет: они появляются, когда фоновый опрос сделает хотя бы один анализ.',
        );

        return;
    }

    const performance = await summarizeIndicatorPerformance(marketConfig.symbol);

    if (performance.length === 0) {
        console.log(
            'Ещё нет горизонтов, которые успели закрыться: 1ч закроется через час после первого голоса, 24ч — через сутки.',
        );

        return;
    }

    console.log('');
    for (const entry of performance) {
        console.log(row(entry));
    }

    console.log('');
    console.log(
        'Доходность знаковая по направлению голоса и за вычетом круговых издержек 0.2%.',
    );
    console.log(
        'Нейтральные голоса не считаются: индикатор, который молчит, не получает ни заслуг, ни вины.',
    );
    console.log('Прошлые голоса не обещают будущих.');
}

// A console command that cannot reach its database must say so and exit
// non-zero, rather than print an empty report that reads like a finding.
main().catch((error: unknown) => {
    console.error('Не удалось прочитать сохранённые голоса:', error);
    process.exit(1);
});