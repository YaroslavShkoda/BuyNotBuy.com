/**
 * Parameter search, printed to the console and to nothing else.
 *
 * **This command proposes; it never promotes.** There is no call here that
 * writes a rule, a strategy version, or a parameter into anything the running
 * system reads. That is the whole reason this file is a command line and not a
 * scheduler: the ladder runs Signal → Outcome → Statistics → Candidate →
 * Backtest → Walk-forward → Shadow → Approval → Production, and a grid search
 * that promoted its own winner would skip the seven rungs between a number and
 * a rule. `optimizer.ts` had been written, tested, and called by nothing, and
 * the honest way to give it a caller is one whose output a person has to read
 * before anything can happen.
 *
 * The report itself lives in `optimize.report.ts` so that checking its text
 * does not require starting a process and fetching candles from an exchange.
 */

import { optimize } from './optimizer.js';
import { describeSearch } from './optimize.report.js';
import { DEFAULT_WALK_FORWARD_OPTIONS } from './walk-forward.js';
import { requiredCandleCount } from '../config/indicator.config.js';
import { marketConfig } from '../config/market.config.js';
import { getMarketData } from '../market/market.service.js';

import type { WalkForwardOptions } from './walk-forward.js';

function integerEnv(name: string, fallback: number): number {
    const raw = process.env[name];

    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }

    const value = Number(raw);

    return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
    const instrument = process.env['OPTIMIZE_INSTRUMENT'] ?? marketConfig.symbol;
    const interval = process.env['OPTIMIZE_INTERVAL'] ?? marketConfig.candleInterval;
    const wanted = integerEnv('OPTIMIZE_CANDLES', 1_000);
    const limit = integerEnv('OPTIMIZE_LIMIT', 400);

    const snapshot = await getMarketData({ instrument, interval });
    const candles = snapshot.data.candles;

    if (candles.length === 0) {
        throw new Error('Биржа не вернула ни одной свечи — искать не по чему');
    }

    // A snapshot taken from the backup venue is a handful of bars, and the
    // failure that follows is a stack trace about EMA warm-up — true, and
    // useless to whoever ran the command. Said here, where the venue that
    // actually answered is known and naming it is the point: the primary
    // being unreachable is the thing worth reporting.
    if (candles.length < wanted) {
        throw new Error(
            `Площадка ${snapshot.data.provider} вернула ${candles.length} свечей вместо ` +
                `запрошенных ${wanted}. Поиск по такому объёму не имеет смысла: ` +
                `и результат, и его проверка на пик относились бы к другой истории.`,
        );
    }

    // **The window does not begin at the first bar.**
    //
    // `startIndex` is where a signal may first be *computed*, not where the
    // series starts. The indicators need `requiredCandleCount()` bars of
    // history before that point, and point-in-time evaluation refuses to score
    // a bar it would have had to invent history for. My first version passed
    // `0` and the search died on `MARKET_INSUFFICIENT_HISTORY` with a message
    // about EMA warm-up — which is correct, and about the wrong bar.
    //
    // The warm-up bars are inside the slice but before the window, so they are
    // not scored and not counted as search results: the search sees only what
    // the walk-forward is allowed to see.
    const warmup = requiredCandleCount();

    if (candles.length <= warmup) {
        throw new Error(
            `Собрано ${candles.length} свечей, а индикаторам нужно ${warmup} для разогрева. ` +
                `Искать не по чему.`,
        );
    }

    const startIndex = warmup;
    const endIndex = Math.min(candles.length, startIndex + wanted);

    const options: WalkForwardOptions = {
        ...DEFAULT_WALK_FORWARD_OPTIONS,
        // Fitting inside the window is what makes the numbers comparable: every
        // candidate is scored by the same walk-forward, so a difference between
        // two of them is a difference in the parameters and not in the method.
        fitParameters: true,
    };

    const result = optimize({
        candles,
        startIndex,
        endIndex,
        options,
        limit,
    });

    console.log(
        describeSearch({
            result,
            market: { instrument, interval, candles: candles.length },
            window: { startIndex, endIndex },
        }),
    );
}

main().catch((error: unknown) => {
    console.error('Не удалось выполнить поиск параметров:', error);

    process.exitCode = 1;
});
