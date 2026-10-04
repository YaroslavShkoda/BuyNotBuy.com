import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { evaluateProtocol, protocolFingerprint } from './holdout-protocol.js';
import { holdoutStatus } from './holdout.js';
import {
    readSealedHoldoutVerdict,
    sealHoldoutVerdict,
} from './holdout-verdict.js';
import { REGISTERED_RULES, registrationOf } from './holdout-registration.js';
import { closePool } from '../db/pool.js';

import type { HoldoutProtocol } from './holdout-protocol.js';
import type { Candle } from '../types/market.js';

/**
 * The one read, and the write that ends it.
 *
 * **This command is the whole point of the window, and it is deliberately hard to
 * run.** It takes the declared metric set, reports every one of them for every
 * registered rule, and stores the result whole. There is no flag to report fewer,
 * no flag to choose a market's worth of bars, and no flag to go back and adjust a
 * rule first — because each of those would be a way of choosing the question
 * after seeing the answer, which is the failure the protocol exists to prevent and
 * the one no schema can catch.
 *
 * Running it twice is refused by the database, not by this file. That is the point
 * of `holdout_verdict`'s `CHECK (id = 1)`: the guarantee lives where the next
 * person to run the command cannot edit it away.
 *
 * Until the window fills — `HOLDOUT_MINIMUM_BARS` daily bars after the commit —
 * this refuses with the protocol's own sentence and writes nothing. That refusal
 * is the expected outcome for the next several months, and it is not a defect.
 */
const CSV = fileURLToPath(
    new URL('../backtest/fixtures/btcusdt-1d-binance.csv', import.meta.url),
);

function loadDaily(): Candle[] {
    const text = readFileSync(CSV, 'utf8');
    const [head, ...rows] = text.trim().split('\n');
    const columns = (head ?? '').split(',').map((name) => name.trim());

    const at = (name: string): number => columns.indexOf(name);

    return rows
        .map((line, index) => {
            const cells = line.split(',');
            const candle: Candle = {
                timestamp: Number(cells[at('timestamp')]),
                open: Number(cells[at('open')]),
                high: Number(cells[at('high')]),
                low: Number(cells[at('low')]),
                close: Number(cells[at('close')]),
                volume: Number(cells[at('volume')]),
            };

            const broken = (Object.keys(candle) as Array<keyof Candle>).filter(
                (field) => !Number.isFinite(candle[field]),
            );

            if (broken.length > 0) {
                // Thrown, not filtered: a dropped bar is a hole in the window,
                // and the whole point of this read is that the window is
                // evaluated whole. An indicator that steps over the hole would
                // still report a well-formed number, so the corruption has to
                // stop here, at load, with the line named.
                throw new Error(
                    `${CSV}: строка ${index + 2}: поле(я) ` +
                        `${broken.join(', ')} не являются конечными числами`,
                );
            }

            return candle;
        });
}

/**
 * Every declared metric, written out rather than assembled.
 *
 * The protocol is a sentence somebody agreed to before the data existed. A set
 * built from the constant would let this file and the constant drift apart
 * without either of them noticing, and the type here is the thing that catches
 * that: a name outside the closed set does not compile.
 */
const PROTOCOL: HoldoutProtocol = {
    metrics: ['totalReturn', 'profitFactor', 'trades', 'winRate', 'maxDrawdown'],
    registeredAt: 0,
    note: 'Полный набор объявленных метрик по каждому зарегистрированному правилу.',
};

const RULES = '─'.repeat(100);

async function main(): Promise<void> {
    const sealed = await readSealedHoldoutVerdict();

    if (sealed !== null) {
        console.log('ОКНО УЖЕ ПРОЧИТАНО');
        console.log(RULES);
        console.log(`  Вердикт записан ${new Date(sealed.createdAt).toISOString()}.`);
        console.log(
            `  Баров в окне: ${sealed.barCount}, с ` +
                `${new Date(sealed.firstBarAt).toISOString().slice(0, 10)} по ` +
                `${new Date(sealed.lastBarAt).toISOString().slice(0, 10)}.`,
        );
        console.log('  Повторное чтение невозможно: строка вердикта одна.');
        console.log('  Перезапуск ничего не изменит и ничего не добавит.');

        if (sealed.protocolFingerprint !== protocolFingerprint(PROTOCOL)) {
            console.log(
                '  ВНИМАНИЕ: набор метрик в этом файле отличается от записанного. ' +
                    'Вердикт хранит тот, по которому читалось.',
            );
        }

        return;
    }

    const candles = loadDaily();
    const candidates = REGISTERED_RULES.map(registrationOf);
    const status = holdoutStatus(candles, candidates);

    if (!status.ready) {
        console.log('ОКНО ЕЩЁ НЕ НАПОЛНЕНО');
        console.log(RULES);
        console.log(`  ${status.message}`);
        console.log(
            '  Ничего не записано. Оценка по неполному окну — это не проверка ' +
                'предсказания, это его сокращение.',
        );

        return;
    }

    const readings = evaluateProtocol(
        PROTOCOL,
        REGISTERED_RULES.map(({ key, strategy }) => ({ key, strategy })),
        candles,
    );

    const stored = await sealHoldoutVerdict({
        candles,
        protocol: PROTOCOL,
        readings,
        candidates,
    });

    console.log('ОКНО ПРОЧИТАНО И ЗАПЕЧАТАНО');
    console.log(RULES);
    console.log(
        `  Баров: ${stored.barCount}. Правил: ${stored.readings.length}. ` +
            'Все метрики, все правила, ничего не выбрано после прочтения.',
    );

    for (const verdict of stored.readings) {
        console.log(`\n  ${verdict.key}`);

        for (const metric of PROTOCOL.metrics) {
            const value = verdict.readings[metric];

            console.log(`    ${metric.padEnd(14)} ${value ?? '—'}`);
        }
    }

    if (stored.protocolFingerprint !== protocolFingerprint(PROTOCOL)) {
        console.log('\n  ВНИМАНИЕ: набор метрик в этом файле отличается от записанного.');
    }
}

try {
    await main();
} catch (error) {
    console.error(
        error instanceof Error ? error.message : 'неизвестная ошибка при запечатывании',
    );
    process.exitCode = 1;
} finally {
    await closePool();
}