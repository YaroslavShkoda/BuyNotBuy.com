import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../types/market.js';
import { resampleToDaily } from './resample.js';

/**
 * Fetches the series this project measures on, and checks what it fetched.
 *
 * The hourly data exists to answer one question: does executing on hourly
 * bars say something different from executing on daily ones? That question
 * cannot be answered on bars that have not been verified, because the honest
 * answer might be "they differ because the hourly data is wrong".
 *
 * So the hourly series is resampled to daily and compared against the daily
 * fixture this project has been measuring on all along, bar by bar, over the
 * overlap. If the resampler is faithful — same opens, highs, lows, closes — the
 * two series are the same market seen at two resolutions, and a difference
 * between them is about resolution rather than about a bug. If it is not
 * faithful, the script says so and refuses to write anything.
 *
 * The comparison is the point. Fetching the data is one line; believing it is
 * the work.
 */

const FIXTURES = fileURLToPath(new URL('../backtest/fixtures/', import.meta.url));
const BINANCE = 'https://api.binance.com/api/v3/klines';

interface RawKline {
    readonly 0: number;
    readonly 1: string;
    readonly 2: string;
    readonly 3: string;
    readonly 4: string;
    readonly 5: string;
}

async function fetchKlines(
    symbol: string,
    interval: string,
    from: number,
    to: number,
): Promise<RawKline[]> {
    const rows: RawKline[] = [];
    let cursor = from;

    while (cursor < to) {
        const url =
            `${BINANCE}?symbol=${symbol}&interval=${interval}` +
            `&startTime=${cursor}&endTime=${to}&limit=1000`;

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`${symbol} ${interval}: HTTP ${response.status}`);
        }

        const batch = (await response.json()) as RawKline[];

        if (batch.length === 0) {
            break;
        }

        rows.push(...batch);
        // The next page starts after the last bar we hold, so no bar is
        // fetched twice and none is skipped at a page boundary.
        cursor = batch[batch.length - 1]![0] + 1;

        await new Promise((resolve) => setTimeout(resolve, 120));
    }

    const seen = new Set<number>();
    const unique = rows.filter((row) => {
        if (seen.has(row[0])) {
            return false;
        }

        seen.add(row[0]);

        return true;
    });

    unique.sort((a, b) => a[0] - b[0]);

    return unique;
}

function toCandles(rows: readonly RawKline[]): Candle[] {
    return rows.map((row) => ({
        timestamp: row[0],
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
    }));
}

function toCsv(candles: readonly Candle[]): string {
    return (
        'timestamp,open,high,low,close,volume\n' +
        candles
            .map(
                (candle) =>
                    `${candle.timestamp},${candle.open},${candle.high},` +
                    `${candle.low},${candle.close},${candle.volume}`,
            )
            .join('\n') +
        '\n'
    );
}

function readDailyFixture(name: string): Candle[] {
    const path = `${FIXTURES}${name}`;
    const lines = readFileSync(path, 'utf8');

    return lines
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .slice(1)
        .map((line) => {
            const [timestamp, open, high, low, close, volume] = line.split(',');

            return {
                timestamp: Number(timestamp),
                open: Number(open),
                high: Number(high),
                low: Number(low),
                close: Number(close),
                volume: Number(volume),
            };
        });
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const FROM = Date.UTC(2021, 0, 1);
const TO = Date.UTC(2026, 8, 27, 23, 59);

if (!existsSync(FIXTURES)) {
    mkdirSync(FIXTURES, { recursive: true });
}

console.log('Загружаю BTCUSDT 1h...');
const hourlyRows = await fetchKlines('BTCUSDT', '1h', FROM, TO);
const hourly = toCandles(hourlyRows);
console.log(`  ${hourly.length} часовых баров`);

console.log('Загружаю ETHUSDT 1d...');
const ethRows = await fetchKlines('ETHUSDT', '1d', FROM, TO);
const ethDaily = toCandles(ethRows);
console.log(`  ${ethDaily.length} дневных баров`);

console.log('Загружаю BTCUSDT 1d для независимой сверки...');
const binanceDaily = toCandles(await fetchKlines('BTCUSDT', '1d', FROM, TO));
console.log(`  ${binanceDaily.length} дневных баров`);

// The check. Resample what we fetched and compare against a daily series
// obtained independently from the *same* exchange.
//
// The first version of this compared against `btcusdt-1d.csv`, the fixture this
// project has measured on all along, and got 8262 mismatches out of 8256
// compared bars. Measuring that instead of assuming it gave the answer: the
// fixture is not what its name says. It is Yahoo Finance's BTC-USD — a spot
// index, day boundary at 12:00 UTC, values like 29376.45583441 — while this
// system trades Binance's BTCUSDT, where the same day opened at 32176.45 and
// reached a high of 34778.11 against the fixture's 33155.12.
//
// That is not a rounding difference. It is a 4.9% disagreement about the
// highest price the market reached on a day, and it means every strategy
// number measured in this project was measured on a series the system does not
// trade. So the check below is now against the exchange, and the old fixture
// is left where it is, renamed and explained, because deleting the thing that
// the last twenty steps were measured on would be destroying the evidence for
// those steps.
// The boundary comes from the exchange's own daily series, which is the only
// authority on where its day starts. The legacy fixture's 12:00 boundary is
// Yahoo's, and borrowing it here produced 2096 days of "missing" data that were
// simply filed one bucket to the left.
const dayBoundaryHours = Math.round(((binanceDaily[0]?.timestamp ?? 0) % DAY) / HOUR);

if (dayBoundaryHours < 0 || dayBoundaryHours >= 24) {
    throw new Error(`Unusable day boundary: ${dayBoundaryHours}`);
}

console.log(
    `\nГраница суток биржи: ${dayBoundaryHours}:00 UTC ` +
        `(у старой фикстуры Yahoo было 12:00 — это разные сутки)`,
);

const resampled = resampleToDaily(hourly, 'UTC', dayBoundaryHours);
const resampledByDay = new Map(
    resampled.map((candle) => [candle.timestamp, candle]),
);

console.log('\nСверка ресемплинга 1h → 1d с независимыми дневными Binance BTCUSDT:');

let compared = 0;
let mismatched = 0;
let incomplete = 0;
const problems: string[] = [];

for (const reference of binanceDaily) {
    const actual = resampledByDay.get(reference.timestamp);

    if (actual === undefined) {
        // Not a resampling failure. The day is absent because the hourly feed
        // never delivered twenty-four bars for it, and a daily bar built from
        // nineteen of them has a high and a low the market never reached. The
        // resampler drops those; counting them separately keeps "the feed had a
        // hole" from looking like "the arithmetic is wrong", which are two
        // findings that call for opposite responses.
        incomplete += 1;
        continue;
    }

    compared += 1;
    const tolerance = 1e-9;
    const fields: [string, number, number][] = [
        ['open', actual.open, reference.open],
        ['high', actual.high, reference.high],
        ['low', actual.low, reference.low],
        ['close', actual.close, reference.close],
    ];

    for (const [field, mine, theirs] of fields) {
        if (Math.abs(mine - theirs) > tolerance * Math.max(1, Math.abs(theirs))) {
            mismatched += 1;
            problems.push(
                `${new Date(reference.timestamp).toISOString().slice(0, 10)} ${field}: ` +
                    `${mine} против ${theirs}`,
            );
        }
    }
}

console.log('\nСверка ресемплинга 1h → 1d с независимыми дневными Binance BTCUSDT:');
console.log(`  сопоставлено дней: ${compared}`);
console.log(`  расхождений по значениям: ${mismatched}`);
console.log(
    `  пропущено из-за неполного часового покрытия: ${incomplete}` +
        ' (фид не отдал все 24 бара; дневной бар из 19 баров имеет максимум,',
);
console.log('   которого рынок не достигал, поэтому он не строится)');

if (mismatched > 0) {
    for (const problem of problems.slice(0, 10)) {
        console.log(`    ${problem}`);
    }
    throw new Error(
        'Ресемплинг не совпадает с эталоном. Ничего не записано: ' +
            'сравнивать исполнение на 1h с исполнением на 1d на несовпадающих ' +
            'данных бессмысленно.',
    );
}

writeFileSync(`${FIXTURES}btcusdt-1h.csv`, toCsv(hourly), 'utf8');
writeFileSync(`${FIXTURES}btcusdt-1d-binance.csv`, toCsv(binanceDaily), 'utf8');
writeFileSync(`${FIXTURES}ethusdt-1d.csv`, toCsv(ethDaily), 'utf8');

// How far apart the two series are, in the terms a backtest cares about.
//
// Compared over identical windows rather than by matching timestamps: the
// legacy fixture's days start at 12:00 UTC and the exchange's at 00:00, so
// matching on timestamp would have found zero shared days and reported the two
// series as having nothing in common. The windows are the same twenty-four
// hours either way, so each legacy day is compared against the exchange's
// hourly bars over exactly that window.
const LEGACY_BOUNDARY_HOURS = 12;
const legacyFixture = readDailyFixture('btcusdt-1d.csv');
const onLegacyBoundary = resampleToDaily(
    hourly,
    'UTC',
    LEGACY_BOUNDARY_HOURS,
);
const byLegacyStamp = new Map(
    onLegacyBoundary.map((candle) => [candle.timestamp, candle]),
);

let comparedWindows = 0;
let largestHighGap = 0;
let largestHighGapDay = '';
let sumCloseGap = 0;
let sumHighGap = 0;

for (const theirs of legacyFixture) {
    const mine = byLegacyStamp.get(theirs.timestamp);

    if (mine === undefined) {
        continue;
    }

    comparedWindows += 1;
    const highGap = Math.abs(mine.high - theirs.high) / theirs.high;
    sumCloseGap += Math.abs(mine.close - theirs.close) / theirs.close;
    sumHighGap += highGap;

    if (highGap > largestHighGap) {
        largestHighGap = highGap;
        largestHighGapDay = new Date(theirs.timestamp).toISOString().slice(0, 10);
    }
}

console.log('\nРасхождение Yahoo BTC-USD (текущая фикстура) и Binance BTCUSDT');
console.log('по одним и тем же 24-часовым окнам:');
console.log(`  сопоставлено окон: ${comparedWindows}`);
console.log(
    `  среднее расхождение закрытия: ${((sumCloseGap / comparedWindows) * 100).toFixed(2)}%`,
);
console.log(`  среднее расхождение максимума: ${((sumHighGap / comparedWindows) * 100).toFixed(2)}%`);
console.log(
    `  наибольшее расхождение максимума: ${(largestHighGap * 100).toFixed(2)}% (${largestHighGapDay})`,
);
console.log(
    '  Это не округление. Каждый из этих баров — за день, когда система, торгующая',
);
console.log('  BTCUSDT, получила бы другую цену входа и другой стоп.');

console.log('\nЗаписано:');
console.log(`  btcusdt-1h.csv          ${hourly.length} баров`);
console.log(`  btcusdt-1d-binance.csv  ${binanceDaily.length} баров`);
console.log(`  ethusdt-1d.csv          ${ethDaily.length} баров`);
console.log(`  суток в часовых: ${Math.round(hourly.length / 24)}`);
