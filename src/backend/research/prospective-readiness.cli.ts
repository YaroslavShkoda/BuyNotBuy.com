import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { assessProspectiveReadiness } from './prospective-readiness.js';
import { validateResearchRegistration } from './research-registration.js';

const protocolBytes = readFileSync(new URL('../../../docs/research-protocol.json', import.meta.url));
const protocol = JSON.parse(protocolBytes.toString('utf8')) as {
    earliestCollectionStart: string;
    normalApproximationIndependentBlocks: number;
};
const checkedAt = Date.now();
if (process.argv.length > 3) throw new Error('Usage: prospective-readiness.cli.ts [registration.json]');
const registrationPath = process.argv[2] ?? new URL('../../../docs/research-registration.json', import.meta.url);
const receipt: unknown = existsSync(registrationPath)
    ? JSON.parse(readFileSync(registrationPath, 'utf8')) : undefined;
const registration = validateResearchRegistration(protocolBytes, receipt, checkedAt);
const sources = [
    { file: 'btcusdt-1h.csv', source: 'binance', symbol: 'BTCUSDT', intervalMs: 3_600_000 },
    { file: 'btcusdt-1d-binance.csv', source: 'binance', symbol: 'BTCUSDT', intervalMs: 86_400_000 },
    { file: 'ethusdt-1d.csv', source: 'binance', symbol: 'ETHUSDT', intervalMs: 86_400_000 },
    { file: 'btcusdt-1d.csv', source: 'yahoo-index', symbol: 'BTC-USD', intervalMs: 86_400_000 },
];
const inventory = sources.map((source) => {
    const bytes = readFileSync(new URL(`../backtest/fixtures/${source.file}`, import.meta.url));
    const rows = bytes.toString('utf8').trim().split(/\r?\n/).slice(1).map((row) => row.split(',').map(Number));
    const timestamps = rows.map((row) => row[0]!);
    const gaps = timestamps.slice(1).filter((timestamp, index) => timestamp - timestamps[index]! !== source.intervalMs).length;
    const invalidOhlcv = rows.filter((row) => {
        const [t, o, h, l, c, v] = row;
        return row.length !== 6 || !row.every(Number.isFinite) || !Number.isSafeInteger(t)
            || o! <= 0 || c! <= 0 || l! <= 0 || h! < Math.max(o!, c!) || l! > Math.min(o!, c!) || v! < 0;
    }).length;
    return {
        ...source,
        provenance: 'repository fixture declaration; upstream source not re-fetched',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bars: rows.length,
        firstBar: new Date(timestamps[0]!).toISOString(),
        lastBar: new Date(timestamps.at(-1)!).toISOString(),
        gaps,
        invalidOhlcv,
        readiness: assessProspectiveReadiness(timestamps, {
            start: registration.effectiveStart, now: checkedAt,
            intervalMs: source.intervalMs,
            minimumIndependentBlocks: protocol.normalApproximationIndependentBlocks,
            ...(registration.state === 'OWNER_ACCEPTED'
                ? { registeredAt: registration.acceptedAt } : {}),
        }),
    };
});
console.info(JSON.stringify({
    format: 'research-readiness/2', checkedAt: new Date(checkedAt).toISOString(),
    protocolSha256: registration.protocolSha256,
    protocolHashFormat: 'sha256-crlf-to-lf/1',
    protocolRawSha256: createHash('sha256').update(protocolBytes).digest('hex'),
    preregistration: registration.state,
    registration: {
        ...registration,
        effectiveStart: new Date(registration.effectiveStart).toISOString(),
        ...(registration.state === 'OWNER_ACCEPTED'
            ? { acceptedAt: new Date(registration.acceptedAt).toISOString() } : {}),
    },
    confidenceIntervals: null, outcome: 'INCONCLUSIVE',
    independentVenueProspectiveCollection: 'NOT_STARTED', inventory,
}, null, 2));
