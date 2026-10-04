/**
 * Filling history backwards, on purpose, by a person.
 *
 * **This is a command, not a scheduler.** The ingestion scheduler already keeps
 * the table filled going forward; what it cannot do is walk backwards through
 * time, which is what a backfill is. Walking backwards is an operator decision —
 * how far, how fast, and which venue's corrections to accept over bars that
 * every signal and outcome in this project is already measured against.
 *
 * It is also the one write in this system that can *change stored history*:
 * `bulkUpsert` issues `ON CONFLICT ... DO UPDATE`, so a bar that is already in
 * the table gets its numbers replaced. The report counts those separately,
 * because a run that quietly rewrote a year of bars would leave every
 * measurement made from them looking like ordinary history.
 */

import { marketConfig } from '../config/market.config.js';
import { describeBackfill } from './backfill.report.js';
import { runBackfill } from './backfill.service.js';
import { configuredSeries } from './ingestion.service.js';

function integerEnv(name: string): number | undefined {
    const raw = process.env[name];

    if (raw === undefined || raw.trim() === '') {
        return undefined;
    }

    const value = Number(raw);

    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} должен быть целым положительным числом, а не «${raw}»`);
    }

    return value;
}

async function main(): Promise<void> {
    // **The market, which used to be the configured one and nothing said so.**
    // `docs/improvements.md` named this call site as still primary-only when C9 was
    // closed, and it was: an operator backfilling a two-market deployment backfilled
    // BTCUSDT and was told nothing about ETHUSDT. `BACKFILL_MARKET` rather than an
    // argument, because every other setting this command reads comes from the
    // environment and a second way in is a second thing to forget.
    const market = (process.env['BACKFILL_MARKET'] ?? marketConfig.symbol).trim().toUpperCase();

    const key = configuredSeries(market);
    const maxCandles = integerEnv('BACKFILL_MAX_CANDLES');
    const untilRaw = integerEnv('BACKFILL_UNTIL');
    const until = untilRaw === undefined ? undefined : untilRaw * 1_000;

    if (maxCandles === undefined) {
        // A run with no budget walks backwards until the venue stops answering,
        // which on a daily series is a long time and a lot of requests for a
        // command somebody typed. Not a hard limit — a required argument.
        throw new Error(
            'Укажите бюджет: BACKFILL_MAX_CANDLES=1000. ' +
                'Без него команда дойдёт до самой древней свечи, которую отдаст биржа.',
        );
    }

    const result = await runBackfill({
        key,
        ...(maxCandles === undefined ? {} : { maxCandles }),
        ...(until === undefined ? {} : { until }),
        onProgress(progress) {
            // One line per page, and it says which bar the next page starts
            // from. A backfill with no output is indistinguishable from a hung
            // one for as long as it takes to notice.
            process.stderr.write(
                `стр. ${progress.pages}: записано ${progress.written}` +
                    ` (перезаписано ${progress.overwritten}), ` +
                    `старый бар ${progress.oldestStored ?? '—'}` +
                    `${progress.done ? ', готово' : ''}\n`,
            );
        },
    });

    console.log(
        describeBackfill({
            result,
            series: {
                provider: key.provider || marketConfig.provider,
                symbol: key.symbol,
                interval: key.interval,
            },
            requested: {
                ...(maxCandles === undefined ? {} : { maxCandles }),
                ...(until === undefined ? {} : { until }),
            },
        }),
    );
}

main().catch((error: unknown) => {
    console.error('Не удалось заполнить историю:', error);

    process.exitCode = 1;
});
